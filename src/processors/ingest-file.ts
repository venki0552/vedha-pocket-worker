import { SupabaseClient } from '@supabase/supabase-js';
import * as pdfjs from 'pdfjs-dist';
import mammoth from 'mammoth';
import { 
  cleanText, 
  chunkText, 
  hashContent,
  CHUNK_TARGET_TOKENS,
  CHUNK_OVERLAP_TOKENS,
  EMBEDDING_BATCH_SIZE,
  STORAGE_BUCKET,
} from '@vedha/shared';
import { OpenRouterEmbeddingProvider } from '@vedha/shared';
import { env } from '../config/env.js';

interface IngestFileJob {
  sourceId: string;
  orgId: string;
  pocketId: string;
  storagePath: string;
  mimeType: string;
}

export async function processIngestFile(
  supabase: SupabaseClient,
  job: IngestFileJob
): Promise<void> {
  const { sourceId, orgId, pocketId, storagePath, mimeType } = job;
  
  console.log(`📁 Ingesting file: ${storagePath}`);
  
  // Update status to extracting
  await supabase
    .from('sources')
    .update({ status: 'extracting' })
    .eq('id', sourceId);
  
  // Download file from Supabase Storage
  const { data: fileData, error: downloadError } = await supabase.storage
    .from(STORAGE_BUCKET)
    .download(storagePath);
  
  if (downloadError || !fileData) {
    throw new Error(`Failed to download file: ${downloadError?.message}`);
  }
  
  // Extract text based on mime type
  let extractedText: string;
  let pages: { page: number; text: string }[] = [];
  
  if (mimeType === 'application/pdf') {
    const result = await extractPdfText(fileData);
    extractedText = result.fullText;
    pages = result.pages;
  } else if (mimeType === 'text/plain') {
    extractedText = await fileData.text();
  } else if (mimeType === 'application/vnd.openxmlformats-officedocument.wordprocessingml.document') {
    extractedText = await extractDocxText(fileData);
  } else {
    throw new Error(`Unsupported mime type: ${mimeType}`);
  }
  
  console.log(`📄 Extracted ${extractedText.length} characters`);
  
  // Update status to chunking
  await supabase
    .from('sources')
    .update({ status: 'chunking' })
    .eq('id', sourceId);
  
  // Clean and chunk text
  const cleanedText = cleanText(extractedText);
  
  // For PDFs with page info, chunk per page
  let chunks: { text: string; index: number; page: number | null }[];
  
  if (pages.length > 0) {
    chunks = [];
    let globalIndex = 0;
    
    for (const pageData of pages) {
      const pageChunks = chunkText(
        cleanText(pageData.text),
        CHUNK_TARGET_TOKENS,
        CHUNK_OVERLAP_TOKENS
      );
      
      for (const chunk of pageChunks) {
        chunks.push({
          text: chunk.text,
          index: globalIndex++,
          page: pageData.page,
        });
      }
    }
  } else {
    chunks = chunkText(cleanedText, CHUNK_TARGET_TOKENS, CHUNK_OVERLAP_TOKENS)
      .map(c => ({ ...c, page: null }));
  }
  
  console.log(`📝 Created ${chunks.length} chunks`);
  
  // Update status to embedding
  await supabase
    .from('sources')
    .update({ status: 'embedding' })
    .eq('id', sourceId);
  
  // Create embedding provider
  const embeddingProvider = new OpenRouterEmbeddingProvider({
    apiKey: env.OPENROUTER_API_KEY,
    baseUrl: env.OPENROUTER_BASE_URL,
    embedModel: env.OPENROUTER_EMBED_MODEL,
  });
  
  // Process chunks in batches
  const chunkRecords: Array<{
    org_id: string;
    pocket_id: string;
    source_id: string;
    idx: number;
    page: number | null;
    text: string;
    content_hash: string;
    embedding: string;
  }> = [];
  
  for (let i = 0; i < chunks.length; i += EMBEDDING_BATCH_SIZE) {
    const batch = chunks.slice(i, i + EMBEDDING_BATCH_SIZE);
    const texts = batch.map(c => c.text);
    
    console.log(`🔢 Embedding batch ${Math.floor(i / EMBEDDING_BATCH_SIZE) + 1}/${Math.ceil(chunks.length / EMBEDDING_BATCH_SIZE)}`);
    
    // Check for existing chunks by content hash
    const hashes = texts.map(t => hashContent(t));
    const { data: existingChunks } = await supabase
      .from('chunks')
      .select('content_hash, embedding')
      .eq('source_id', sourceId)
      .in('content_hash', hashes);
    
    const existingHashMap = new Map(
      (existingChunks || []).map(c => [c.content_hash, c.embedding])
    );
    
    // Only embed texts that don't have existing embeddings
    const textsToEmbed: string[] = [];
    const indexMap: number[] = [];
    
    texts.forEach((text, idx) => {
      const hash = hashes[idx];
      if (!existingHashMap.has(hash)) {
        textsToEmbed.push(text);
        indexMap.push(idx);
      }
    });
    
    let newEmbeddings: number[][] = [];
    if (textsToEmbed.length > 0) {
      newEmbeddings = await embeddingProvider.embed(textsToEmbed);
    }
    
    // Build chunk records
    let embeddingIdx = 0;
    for (let j = 0; j < batch.length; j++) {
      const chunk = batch[j];
      const hash = hashes[j];
      
      let embedding: number[];
      if (existingHashMap.has(hash)) {
        embedding = existingHashMap.get(hash)!;
      } else {
        embedding = newEmbeddings[embeddingIdx++];
      }
      
      chunkRecords.push({
        org_id: orgId,
        pocket_id: pocketId,
        source_id: sourceId,
        idx: chunk.index,
        page: chunk.page,
        text: chunk.text,
        content_hash: hash,
        embedding: `[${embedding.join(',')}]`,
      });
    }
  }
  
  // Delete existing chunks for this source (for reprocessing)
  await supabase.from('chunks').delete().eq('source_id', sourceId);
  
  // Insert new chunks
  const { error: insertError } = await supabase
    .from('chunks')
    .insert(chunkRecords);
  
  if (insertError) {
    throw new Error(`Failed to insert chunks: ${insertError.message}`);
  }
  
  // Update source status to ready
  await supabase
    .from('sources')
    .update({ status: 'ready' })
    .eq('id', sourceId);
  
  // Log audit event
  await supabase.from('audit_events').insert({
    org_id: orgId,
    pocket_id: pocketId,
    event_type: 'pipeline_completed',
    metadata: {
      source_id: sourceId,
      chunks_created: chunkRecords.length,
    },
  });
  
  console.log(`✅ Source ${sourceId} processed successfully with ${chunkRecords.length} chunks`);
}

async function extractPdfText(blob: Blob): Promise<{ fullText: string; pages: { page: number; text: string }[] }> {
  const arrayBuffer = await blob.arrayBuffer();
  const data = new Uint8Array(arrayBuffer);
  
  // Load the PDF
  const loadingTask = pdfjs.getDocument({ data });
  const pdf = await loadingTask.promise;
  
  const pages: { page: number; text: string }[] = [];
  let fullText = '';
  
  for (let pageNum = 1; pageNum <= pdf.numPages; pageNum++) {
    const page = await pdf.getPage(pageNum);
    const textContent = await page.getTextContent();
    
    const pageText = textContent.items
      .map((item: any) => item.str)
      .join(' ');
    
    pages.push({ page: pageNum, text: pageText });
    fullText += pageText + '\n\n';
  }
  
  return { fullText, pages };
}

async function extractDocxText(blob: Blob): Promise<string> {
  const arrayBuffer = await blob.arrayBuffer();
  const buffer = Buffer.from(arrayBuffer);
  
  const result = await mammoth.extractRawText({ buffer });
  return result.value;
}
