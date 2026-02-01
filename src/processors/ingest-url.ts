import { SupabaseClient } from '@supabase/supabase-js';
import { JSDOM } from 'jsdom';
import { Readability } from '@mozilla/readability';
import { 
  cleanText, 
  chunkText, 
  hashContent,
  validateUrlForSsrf,
  CHUNK_TARGET_TOKENS,
  CHUNK_OVERLAP_TOKENS,
  EMBEDDING_BATCH_SIZE,
} from '@vedha/shared';
import { OpenRouterEmbeddingProvider } from '@vedha/shared';
import { env } from '../config/env.js';

interface IngestUrlJob {
  sourceId: string;
  orgId: string;
  pocketId: string;
  url: string;
}

export async function processIngestUrl(
  supabase: SupabaseClient,
  job: IngestUrlJob
): Promise<void> {
  const { sourceId, orgId, pocketId, url } = job;
  
  console.log(`🌐 Ingesting URL: ${url}`);
  
  // SSRF Protection: Validate URL before processing
  try {
    validateUrlForSsrf(url);
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : 'Invalid URL';
    console.error(`🚫 SSRF Protection blocked URL: ${url} - ${errorMessage}`);
    
    await supabase
      .from('sources')
      .update({ 
        status: 'failed',
        error_message: `Security validation failed: ${errorMessage}`
      })
      .eq('id', sourceId);
    
    throw new Error(`URL blocked by security policy: ${errorMessage}`);
  }
  
  // Update status to extracting
  await supabase
    .from('sources')
    .update({ status: 'extracting' })
    .eq('id', sourceId);
  
  // Fetch the URL
  let html: string;
  let title: string | undefined;
  
  try {
    const response = await fetch(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (compatible; VedhaPocket/1.0; +https://vedha.pocket)',
      },
    });
    
    if (!response.ok) {
      throw new Error(`Failed to fetch URL: ${response.status}`);
    }
    
    html = await response.text();
  } catch (error) {
    // Try Playwright fallback if enabled
    if (env.PLAYWRIGHT_ENABLED) {
      console.log('📺 Trying Playwright fallback...');
      const result = await fetchWithPlaywright(url);
      html = result.html;
      title = result.title;
    } else {
      throw error;
    }
  }
  
  // Parse with Readability
  const dom = new JSDOM(html, { url });
  const reader = new Readability(dom.window.document);
  const article = reader.parse();
  
  if (!article || !article.textContent || article.textContent.length < 100) {
    // Content too short, try Playwright
    if (env.PLAYWRIGHT_ENABLED && html.length > 0) {
      console.log('📺 Content too short, trying Playwright...');
      const result = await fetchWithPlaywright(url);
      const dom2 = new JSDOM(result.html, { url });
      const reader2 = new Readability(dom2.window.document);
      const article2 = reader2.parse();
      
      if (article2 && article2.textContent && article2.textContent.length > 100) {
        return processExtractedContent(supabase, {
          sourceId,
          orgId,
          pocketId,
          title: article2.title || result.title || url,
          content: article2.textContent,
        });
      }
    }
    
    throw new Error('Could not extract meaningful content from URL');
  }
  
  // Process extracted content
  await processExtractedContent(supabase, {
    sourceId,
    orgId,
    pocketId,
    title: title || article.title || url,
    content: article.textContent,
  });
}

async function fetchWithPlaywright(url: string): Promise<{ html: string; title: string }> {
  const { chromium } = await import('playwright');
  
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage();
  
  try {
    // Use domcontentloaded instead of networkidle - many sites never reach networkidle
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60000 });
    
    // Wait for content to render
    await page.waitForTimeout(3000);
    
    const html = await page.content();
    const title = await page.title();
    
    return { html, title };
  } finally {
    await browser.close();
  }
}

interface ExtractedContent {
  sourceId: string;
  orgId: string;
  pocketId: string;
  title: string;
  content: string;
}

// Common bot-block and error page phrases to detect invalid content
const BOT_BLOCK_PHRASES = [
  'verifying you are human',
  'checking your browser',
  'just a moment',
  'please wait while we verify',
  'cloudflare',
  'ddos protection',
  'access denied',
  'please enable javascript',
  'please enable cookies',
  'captcha',
  'are you a robot',
  'security check',
  'unusual traffic',
  'bot detection',
];

/**
 * Validate that extracted content is meaningful and not a bot-block page
 */
function validateContent(content: string, title: string): { valid: boolean; reason?: string } {
  const lowerContent = content.toLowerCase();
  const lowerTitle = title.toLowerCase();
  
  // Check for bot-block phrases
  for (const phrase of BOT_BLOCK_PHRASES) {
    if (lowerContent.includes(phrase) || lowerTitle.includes(phrase)) {
      return { valid: false, reason: `Bot protection detected: "${phrase}"` };
    }
  }
  
  // Check if content is too short (less than 200 chars of actual content)
  const contentWithoutWhitespace = content.replace(/\s+/g, '');
  if (contentWithoutWhitespace.length < 200) {
    return { valid: false, reason: 'Content too short (less than 200 characters)' };
  }
  
  // Check if content is mostly repetitive (sign of blocked page)
  const words = content.toLowerCase().split(/\s+/).filter(w => w.length > 3);
  const uniqueWords = new Set(words);
  const uniqueRatio = uniqueWords.size / Math.max(words.length, 1);
  if (words.length > 20 && uniqueRatio < 0.3) {
    return { valid: false, reason: 'Content appears repetitive (possible blocked page)' };
  }
  
  return { valid: true };
}

async function processExtractedContent(
  supabase: SupabaseClient,
  { sourceId, orgId, pocketId, title, content }: ExtractedContent
): Promise<void> {
  // Validate content before processing
  const validation = validateContent(content, title);
  if (!validation.valid) {
    console.error(`❌ Content validation failed: ${validation.reason}`);
    await supabase
      .from('sources')
      .update({ 
        status: 'failed',
        error_message: validation.reason,
      })
      .eq('id', sourceId);
    throw new Error(validation.reason);
  }
  
  console.log(`✅ Content validation passed`);
  
  // Update status to chunking
  await supabase
    .from('sources')
    .update({ 
      status: 'chunking',
      title,
      size_bytes: Buffer.byteLength(content, 'utf-8'),
    })
    .eq('id', sourceId);
  
  // Clean and chunk text
  const cleanedText = cleanText(content);
  const chunks = chunkText(cleanedText, CHUNK_TARGET_TOKENS, CHUNK_OVERLAP_TOKENS);
  
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
        page: null, // URLs don't have pages
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
