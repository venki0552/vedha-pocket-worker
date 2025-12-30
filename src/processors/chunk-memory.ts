import { SupabaseClient } from '@supabase/supabase-js';
import { 
  cleanText, 
  chunkText, 
  hashContent,
  CHUNK_TARGET_TOKENS,
  CHUNK_OVERLAP_TOKENS,
  EMBEDDING_BATCH_SIZE,
} from '@vedha/shared';
import { OpenRouterEmbeddingProvider } from '@vedha/shared';
import { env } from '../config/env.js';
import { decryptApiKey } from '../services/encryption.js';

interface ChunkMemoryJob {
  memoryId: string;
  orgId: string;
  userId: string;
}

export async function processChunkMemory(
  supabase: SupabaseClient,
  job: ChunkMemoryJob
): Promise<void> {
  const { memoryId, orgId, userId } = job;
  
  console.log(`🧠 Processing memory: ${memoryId}`);
  
  // Get user's API key from database
  const { data: settings, error: settingsError } = await supabase
    .from('user_settings')
    .select('openrouter_api_key_encrypted')
    .eq('user_id', userId)
    .single();
  
  let apiKey: string;
  if (settings?.openrouter_api_key_encrypted) {
    apiKey = decryptApiKey(settings.openrouter_api_key_encrypted);
    console.log('🔑 Using user\'s OpenRouter API key');
  } else if (env.OPENROUTER_API_KEY) {
    apiKey = env.OPENROUTER_API_KEY;
    console.log('🔑 Using shared OpenRouter API key');
  } else {
    throw new Error('No API key configured for user');
  }
  
  // Get memory content
  const { data: memory, error: fetchError } = await supabase
    .from('memories')
    .select('*')
    .eq('id', memoryId)
    .single();
  
  if (fetchError || !memory) {
    throw new Error(`Memory not found: ${memoryId}`);
  }
  
  // Use plain text content (strip HTML)
  const textContent = memory.content || '';
  
  if (textContent.length < 10) {
    console.log('⚠️ Memory content too short, skipping chunking');
    return;
  }
  
  // Delete existing chunks for this memory
  const { error: deleteError } = await supabase
    .from('memory_chunks')
    .delete()
    .eq('memory_id', memoryId);
  
  if (deleteError) {
    console.warn('⚠️ Error deleting existing chunks:', deleteError);
  }
  
  // Clean and chunk text
  const cleanedText = cleanText(textContent);
  
  // For memories, use smaller chunks
  const chunks = chunkText(cleanedText, CHUNK_TARGET_TOKENS / 2, CHUNK_OVERLAP_TOKENS / 2);
  
  console.log(`📝 Created ${chunks.length} chunks for memory`);
  
  // Create embedding provider with user's API key
  const embeddingProvider = new OpenRouterEmbeddingProvider({
    apiKey,
    baseUrl: env.OPENROUTER_BASE_URL,
    embedModel: env.OPENROUTER_EMBED_MODEL,
  });
  
  // Process chunks in batches
  const chunkRecords: Array<{
    org_id: string;
    memory_id: string;
    idx: number;
    text: string;
    content_hash: string;
    embedding: string;
  }> = [];
  
  for (let i = 0; i < chunks.length; i += EMBEDDING_BATCH_SIZE) {
    const batch = chunks.slice(i, i + EMBEDDING_BATCH_SIZE);
    const texts = batch.map(c => c.text);
    
    console.log(`🔢 Embedding batch ${Math.floor(i / EMBEDDING_BATCH_SIZE) + 1}/${Math.ceil(chunks.length / EMBEDDING_BATCH_SIZE)}`);
    
    // Generate embeddings (embed() accepts an array of texts)
    const embeddings = await embeddingProvider.embed(texts);
    
    // Create chunk records
    for (let j = 0; j < batch.length; j++) {
      const chunk = batch[j];
      const embedding = embeddings[j];
      const hash = hashContent(chunk.text);
      
      chunkRecords.push({
        org_id: orgId,
        memory_id: memoryId,
        idx: i + j,
        text: chunk.text,
        content_hash: hash,
        embedding: JSON.stringify(embedding),
      });
    }
  }
  
  // Insert all chunks
  if (chunkRecords.length > 0) {
    const { error: insertError } = await supabase
      .from('memory_chunks')
      .insert(chunkRecords);
    
    if (insertError) {
      console.error('❌ Error inserting chunks:', insertError);
      throw insertError;
    }
    
    console.log(`✅ Inserted ${chunkRecords.length} chunks for memory ${memoryId}`);
  }
  
  console.log(`✅ Memory ${memoryId} processed successfully`);
}
