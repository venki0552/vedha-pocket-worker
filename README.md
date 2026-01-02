# Memory Palace Worker (vedha-pocket-worker)

A background job processor for the Memory Palace knowledge management system. Handles web scraping, document processing, and embedding generation.

## 🌟 Features

### Document Processing

- 🕷️ **Web Scraping** — Playwright-powered browser automation for JavaScript-heavy sites
- 📄 **PDF Processing** — Page-level chunking with page numbers preserved
- 📝 **Office Documents** — DOCX, TXT, Markdown support
- 🧩 **Smart Chunking** — RecursiveCharacterTextSplitter (1000 chars, 200 overlap)

### Embedding Generation

- 🔢 **High-Dimension Vectors** — text-embedding-3-large (3072 dimensions for docs, 1536 for memories)
- 🔄 **Batch Processing** — Efficient bulk embedding generation
- 🔐 **User API Keys** — Uses encrypted user API keys from database

### Job Queue

- 📬 **BullMQ** — Redis-backed reliable job queue
- ♻️ **Auto-Retry** — Configurable retry with exponential backoff
- 📊 **Progress Tracking** — Real-time status updates to database
- 🔄 **Concurrency Control** — Configurable worker parallelism

### Bot Detection & Resilience

- 🤖 **Anti-Bot Handling** — Detects CloudFlare, CAPTCHA, access denied pages
- 🛡️ **Graceful Failures** — Marks sources as failed instead of saving junk
- 📝 **Error Logging** — Detailed error messages for debugging

## 🚀 Quick Start

```bash
# Install dependencies
npm install

# Install Playwright browsers
npx playwright install chromium

# Copy environment variables
cp .env.example .env
# Edit .env with your values

# Run in development
npm run dev

# Build for production
npm run build
npm start
```

## 🔧 Environment Variables

| Variable                    | Description                                       | Required |
| --------------------------- | ------------------------------------------------- | -------- |
| `SUPABASE_URL`              | Supabase project URL                              | Yes      |
| `SUPABASE_ANON_KEY`         | Supabase anon key                                 | Yes      |
| `SUPABASE_SERVICE_ROLE_KEY` | Supabase service role key                         | Yes      |
| `REDIS_URL`                 | Redis connection URL                              | Yes      |
| `OPENROUTER_API_KEY`        | OpenRouter API key (fallback)                     | Yes      |
| `OPENROUTER_BASE_URL`       | OpenRouter base URL                               | No       |
| `OPENROUTER_EMBED_MODEL`    | Embedding model (default: text-embedding-3-large) | No       |
| `ENCRYPTION_KEY`            | 32-byte key for API key decryption                | Yes      |
| `PLAYWRIGHT_ENABLED`        | Enable browser-based scraping (default: true)     | No       |
| `WORKER_CONCURRENCY`        | Max concurrent jobs (default: 5)                  | No       |

## 📋 Job Types

### ingest-url

Processes web URLs:

1. **Fetch** — Uses Playwright to render JavaScript
2. **Extract** — Readability algorithm for main content
3. **Clean** — Removes scripts, styles, navigation
4. **Chunk** — Splits into 1000-char segments
5. **Embed** — Generates 3072-dim vectors
6. **Store** — Saves to Supabase with pgvector

### ingest-file

Processes uploaded files:

1. **Download** — Fetches from Supabase Storage
2. **Parse** — PDF (pdf-parse), DOCX (mammoth), TXT/MD (direct)
3. **Chunk** — Page-aware chunking for PDFs
4. **Embed** — Generates embeddings
5. **Store** — Saves chunks with page numbers

### chunk-memory

Processes personal memories:

1. **Extract** — Gets memory content from database
2. **Chunk** — Smaller chunks (500 chars) for memories
3. **Embed** — 1536-dim vectors (smaller model)
4. **Store** — Links to memory_chunks table

## 🏗️ Architecture

```
┌─────────────────┐     ┌─────────────────┐     ┌─────────────────┐
│   API Server    │────▶│   Redis Queue   │────▶│     Worker      │
│  (Job Creator)  │     │    (BullMQ)     │     │   (Processor)   │
└─────────────────┘     └─────────────────┘     └────────┬────────┘
                                                         │
                         ┌───────────────────────────────┼───────────────────────────────┐
                         │                               │                               │
                         ▼                               ▼                               ▼
                ┌─────────────────┐             ┌─────────────────┐             ┌─────────────────┐
                │   Playwright    │             │    Supabase     │             │   OpenRouter    │
                │   (Scraping)    │             │   (Storage)     │             │  (Embeddings)   │
                └─────────────────┘             └─────────────────┘             └─────────────────┘
```

## 📁 Project Structure

```
src/
├── index.ts              # Worker entry point, queue setup
├── config/
│   └── env.ts            # Environment configuration
├── processors/
│   ├── ingest-url.ts     # URL scraping processor
│   ├── ingest-file.ts    # File processing processor
│   └── chunk-memory.ts   # Memory chunking processor
└── services/
    └── encryption.ts     # API key decryption

shared/                   # Shared with API
├── llm/
│   └── index.ts          # OpenRouterEmbeddingProvider
├── types/
│   └── index.ts          # TypeScript types
├── constants/
│   └── index.ts          # Chunking constants
└── utils/
    └── index.ts          # Utility functions
```

## 🕷️ Web Scraping Details

### Playwright Configuration

- **Browser**: Chromium (headless)
- **Viewport**: 1920x1080
- **Timeout**: 30 seconds
- **User Agent**: Chrome 120 on Windows

### Content Extraction

- Uses Mozilla Readability for clean article extraction
- Falls back to body text if Readability fails
- Captures: title, description, author, publish date

### Bot Detection Patterns

The worker checks for these indicators and fails gracefully:

```javascript
const BOT_DETECTION_PATTERNS = [
	"Please enable JavaScript",
	"Access Denied",
	"blocked",
	"CAPTCHA",
	"Cloudflare",
	"Just a moment...",
	"Checking your browser",
	"DDoS protection",
];
```

## 📄 Document Processing

### PDF

- Uses `pdf-parse` for text extraction
- Chunks by page with page numbers preserved
- Citations include `[Source: Title (Page N)]`

### DOCX

- Uses `mammoth` for conversion
- Extracts plain text from Word documents
- Preserves paragraph structure

### TXT/Markdown

- Direct text extraction
- Markdown formatting preserved in chunks

## 🔄 Retry Strategy

Jobs are retried with exponential backoff:

| Attempt | Delay            |
| ------- | ---------------- |
| 1       | 30 seconds       |
| 2       | 1 minute         |
| 3       | 2 minutes        |
| 4       | 5 minutes        |
| 5       | 10 minutes (max) |

## 🐳 Docker

```bash
# Build (includes Playwright browsers)
docker build -t memory-palace-worker .

# Run
docker run --env-file .env memory-palace-worker
```

### Dockerfile Notes

- Uses `mcr.microsoft.com/playwright` base image
- Installs Chromium browser
- Runs as non-root user

## 📊 Monitoring

### Job Status Flow

```
queued → processing → complete
                   → failed (with error_message)
```

### Database Updates

The worker updates `sources` table:

- `status`: processing, complete, failed
- `error_message`: Failure reason
- `size_bytes`: Processed content size

### Logs

- `[Worker]` prefix for all logs
- Job ID and type in each message
- Error stack traces for failures

## 🔗 Related Repos

- **API**: [vedha-pocket-api](https://github.com/venki0552/vedha-pocket-api)
- **Web**: [vedha-pocket-web](https://github.com/venki0552/vedha-pocket-web)

## 📄 License

MIT
