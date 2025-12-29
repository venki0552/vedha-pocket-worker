# Vedha Pocket Worker

A background job processor for the Vedha Pocket knowledge management system. Handles web scraping, document processing, and embedding generation.

## Features

- 🕷️ Web scraping with Playwright (handles SPAs and JavaScript)
- 📄 Document processing (PDF, DOCX, TXT, Markdown)
- 🧩 Smart chunking with RecursiveCharacterTextSplitter
- 🔢 Embedding generation (text-embedding-3-large)
- 🔄 BullMQ job queue with Redis
- 🤖 Bot detection handling

## Quick Start

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

## Environment Variables

| Variable                    | Description                       | Required |
| --------------------------- | --------------------------------- | -------- |
| `SUPABASE_URL`              | Supabase project URL              | Yes      |
| `SUPABASE_ANON_KEY`         | Supabase anon key                 | Yes      |
| `SUPABASE_SERVICE_ROLE_KEY` | Supabase service role key         | Yes      |
| `REDIS_URL`                 | Redis connection URL              | Yes      |
| `OPENROUTER_API_KEY`        | OpenRouter API key                | Yes      |
| `OPENROUTER_BASE_URL`       | OpenRouter base URL               | No       |
| `OPENROUTER_EMBED_MODEL`    | Embedding model                   | No       |
| `MAX_CONCURRENT_JOBS`       | Concurrent job limit (default: 5) | No       |

## Job Types

### ingest

Processes URLs and documents:

1. Fetches content (web scraping or file parsing)
2. Cleans and normalizes text
3. Chunks content (1000 chars, 200 overlap)
4. Generates embeddings (3072 dimensions)
5. Stores in Supabase with pgvector

### Web Scraping

- Uses Playwright for JavaScript-heavy sites
- Handles bot detection with fallback extraction
- Extracts main content using Readability
- Captures title, description, meta tags

### Document Processing

- PDF: pdf-parse
- DOCX: mammoth
- TXT/MD: Direct text extraction

## Architecture

```
┌─────────────────┐     ┌─────────────┐     ┌──────────────┐
│   BullMQ Job    │────▶│   Worker    │────▶│   Supabase   │
│     Queue       │     │  Processor  │     │   Database   │
└─────────────────┘     └─────────────┘     └──────────────┘
         ▲                     │
         │                     ▼
    ┌────┴────┐         ┌─────────────┐
    │  Redis  │         │  OpenRouter │
    └─────────┘         │  Embeddings │
                        └─────────────┘
```

## Docker

```bash
docker build -t vedha-pocket-worker .
docker run --env-file .env vedha-pocket-worker
```

## License

MIT
