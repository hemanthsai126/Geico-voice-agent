import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { join } from "node:path";

type KnowledgePage = {
  title: string;
  sourceUrl: string;
  fileName: string;
  text: string;
};

type KnowledgeSection = {
  title: string;
  sourceUrl: string;
  fileName: string;
  heading: string;
  text: string;
};

type KnowledgeChunk = KnowledgeSection & {
  id: string;
};

type SemanticIndex = {
  version: 1;
  embeddingModel: string;
  sourceHash: string;
  chunks: Array<KnowledgeChunk & { embedding: number[] }>;
};

export type KnowledgeSearchResult = {
  title: string;
  sourceUrl: string;
  heading: string;
  snippet: string;
  score: number;
  retrievalMethod?: "semantic" | "keyword";
};

type KnowledgeSearchOptions = {
  apiKey?: string;
  embeddingModel?: string;
  limit?: number;
  forceKeyword?: boolean;
};

let cachedPages: KnowledgePage[] | undefined;
let cachedSections: KnowledgeSection[] | undefined;
let cachedSemanticIndex: SemanticIndex | undefined;

const geicoPagesDir = join(process.cwd(), "Geico Data", "pages");
const semanticIndexPath = join(process.cwd(), "Geico Data", "semantic-index.json");
const defaultEmbeddingModel = "text-embedding-3-small";

const synonymMap: Record<string, string[]> = {
  app: ["mobile", "digital", "id card", "policy", "claim"],
  coverage: ["cover", "protection", "insurance"],
  comprehensive: ["theft", "vandalism", "fire", "flood", "hail"],
  collision: ["accident", "damage", "repair"],
  deductible: ["deductibles", "pay out of pocket"],
  discount: ["save", "savings", "cheap"],
  rental: ["reimbursement", "rental car"],
  roadside: ["tow", "towing", "lockout", "jump start"],
  uninsured: ["underinsured", "motorist"],
};

export async function searchGeicoAutoKnowledge(
  query: string,
  optionsOrLimit: KnowledgeSearchOptions | number = {},
): Promise<KnowledgeSearchResult[]> {
  const normalizedQuery = query.trim().toLowerCase();
  if (!normalizedQuery) return [];

  const options = typeof optionsOrLimit === "number" ? { limit: optionsOrLimit } : optionsOrLimit;
  const limit = options.limit ?? 5;

  if (options.apiKey && !options.forceKeyword) {
    return searchGeicoAutoKnowledgeSemantically(query, {
      apiKey: options.apiKey,
      embeddingModel: options.embeddingModel ?? defaultEmbeddingModel,
      limit,
    });
  }

  return searchGeicoAutoKnowledgeByKeyword(normalizedQuery, limit);
}

async function searchGeicoAutoKnowledgeSemantically(
  query: string,
  options: Required<Pick<KnowledgeSearchOptions, "apiKey" | "embeddingModel" | "limit">>,
): Promise<KnowledgeSearchResult[]> {
  const index = await loadSemanticIndex(options.apiKey, options.embeddingModel);
  const [queryEmbedding] = await createEmbeddings([query], options.apiKey, options.embeddingModel);

  return index.chunks
    .map((chunk) => ({
      title: chunk.title,
      sourceUrl: chunk.sourceUrl,
      heading: chunk.heading,
      snippet: buildSemanticSnippet(chunk.text),
      score: cosineSimilarity(queryEmbedding, chunk.embedding),
      retrievalMethod: "semantic" as const,
    }))
    .sort((a, b) => b.score - a.score)
    .slice(0, options.limit);
}

async function searchGeicoAutoKnowledgeByKeyword(normalizedQuery: string, limit: number): Promise<KnowledgeSearchResult[]> {

  const baseTerms = normalizedQuery
    .split(/[^a-z0-9]+/i)
    .filter((term) => term.length > 2)
    .slice(0, 12);

  const terms = expandTerms(baseTerms);
  if (terms.length === 0) return [];

  const sections = await loadKnowledgeSections();
  return sections
    .map((section) => {
      const lowerText = `${section.title}\n${section.heading}\n${section.text}`.toLowerCase();
      const headingScore = terms.reduce((total, term) => total + countOccurrences(section.heading.toLowerCase(), term) * 4, 0);
      const titleScore = terms.reduce((total, term) => total + countOccurrences(section.title.toLowerCase(), term) * 3, 0);
      const bodyScore = terms.reduce((total, term) => total + countOccurrences(lowerText, term), 0);
      const score = headingScore + titleScore + bodyScore;
      return {
        title: section.title,
        sourceUrl: section.sourceUrl,
        heading: section.heading,
        snippet: buildSnippet(section.text, terms),
        score,
        retrievalMethod: "keyword" as const,
      };
    })
    .filter((result) => result.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, limit);
}

async function loadSemanticIndex(apiKey: string, embeddingModel: string): Promise<SemanticIndex> {
  const chunks = await loadKnowledgeChunks();
  const sourceHash = hashChunks(chunks);

  if (
    cachedSemanticIndex?.embeddingModel === embeddingModel &&
    cachedSemanticIndex.sourceHash === sourceHash
  ) {
    return cachedSemanticIndex;
  }

  const savedIndex = await readSavedSemanticIndex();
  if (savedIndex?.embeddingModel === embeddingModel && savedIndex.sourceHash === sourceHash) {
    cachedSemanticIndex = savedIndex;
    return savedIndex;
  }

  const embeddings = await createEmbeddings(chunks.map(chunkToEmbeddingInput), apiKey, embeddingModel);
  cachedSemanticIndex = {
    version: 1,
    embeddingModel,
    sourceHash,
    chunks: chunks.map((chunk, index) => ({
      ...chunk,
      embedding: embeddings[index] ?? [],
    })),
  };

  try {
    await mkdir(join(process.cwd(), "Geico Data"), { recursive: true });
    await writeFile(semanticIndexPath, JSON.stringify(cachedSemanticIndex, null, 2), "utf-8");
  } catch {
    // Read-only filesystem (e.g. Vercel) — index stays in memory only.
  }

  return cachedSemanticIndex;
}

async function readSavedSemanticIndex(): Promise<SemanticIndex | undefined> {
  try {
    const parsed = JSON.parse(await readFile(semanticIndexPath, "utf-8")) as SemanticIndex;
    if (parsed.version !== 1 || !Array.isArray(parsed.chunks)) return undefined;
    return parsed;
  } catch {
    return undefined;
  }
}

async function loadKnowledgeChunks(): Promise<KnowledgeChunk[]> {
  const sections = await loadKnowledgeSections();
  return sections.flatMap((section, sectionIndex) => splitSectionIntoChunks(section, sectionIndex));
}

function splitSectionIntoChunks(section: KnowledgeSection, sectionIndex: number): KnowledgeChunk[] {
  const normalizedText = section.text.replace(/\s+/g, " ").trim();
  const maxLength = 1600;
  const overlap = 220;

  if (normalizedText.length <= maxLength) {
    return [
      {
        ...section,
        id: `${section.fileName}:${sectionIndex}:0`,
        text: normalizedText,
      },
    ];
  }

  const chunks: KnowledgeChunk[] = [];
  let start = 0;
  let chunkIndex = 0;

  while (start < normalizedText.length) {
    const end = Math.min(normalizedText.length, start + maxLength);
    const sentenceEnd = normalizedText.lastIndexOf(". ", end);
    const finalEnd = sentenceEnd > start + maxLength * 0.55 ? sentenceEnd + 1 : end;
    chunks.push({
      ...section,
      id: `${section.fileName}:${sectionIndex}:${chunkIndex}`,
      text: normalizedText.slice(start, finalEnd).trim(),
    });

    if (finalEnd >= normalizedText.length) break;
    start = Math.max(0, finalEnd - overlap);
    chunkIndex += 1;
  }

  return chunks;
}

function hashChunks(chunks: KnowledgeChunk[]): string {
  const hash = createHash("sha256");
  for (const chunk of chunks) {
    hash.update(chunk.id);
    hash.update(chunk.title);
    hash.update(chunk.heading);
    hash.update(chunk.text);
  }
  return hash.digest("hex");
}

function chunkToEmbeddingInput(chunk: KnowledgeChunk): string {
  return [chunk.title, chunk.heading, chunk.text].filter(Boolean).join("\n\n");
}

async function createEmbeddings(inputs: string[], apiKey: string, embeddingModel: string): Promise<number[][]> {
  const embeddings: number[][] = [];
  const batchSize = 64;

  for (let index = 0; index < inputs.length; index += batchSize) {
    const batch = inputs.slice(index, index + batchSize);
    const response = await fetch("https://api.openai.com/v1/embeddings", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: embeddingModel,
        input: batch,
      }),
    });

    const data = (await response.json()) as {
      data?: Array<{ index: number; embedding: number[] }>;
      error?: { message?: string };
    };
    if (!response.ok) {
      throw new Error(data?.error?.message ?? "Failed to create GEICO knowledge embeddings.");
    }

    const batchEmbeddings = (data.data ?? [])
      .sort((a: { index: number }, b: { index: number }) => a.index - b.index)
      .map((item: { embedding: number[] }) => item.embedding);
    embeddings.push(...batchEmbeddings);
  }

  return embeddings;
}

async function loadKnowledgeSections(): Promise<KnowledgeSection[]> {
  if (cachedSections) return cachedSections;

  const pages = await loadKnowledgePages();
  cachedSections = pages.flatMap(splitIntoSections);

  return cachedSections;
}

async function loadKnowledgePages(): Promise<KnowledgePage[]> {
  if (cachedPages) return cachedPages;

  const fileNames = (await readdir(geicoPagesDir)).filter((fileName) => fileName.endsWith(".txt"));
  cachedPages = await Promise.all(
    fileNames.map(async (fileName) => {
      const text = await readFile(join(geicoPagesDir, fileName), "utf-8");
      const lines = text.split(/\r?\n/);
      const title = lines[0]?.replace(/^#\s*/, "").trim() || fileName;
      const sourceUrl = lines.find((line) => line.startsWith("Source URL:"))?.replace("Source URL:", "").trim() ?? "";
      const body = lines.slice(6).join("\n").trim();

      return {
        title,
        sourceUrl,
        fileName,
        text: body,
      };
    }),
  );

  return cachedPages;
}

function buildSnippet(text: string, terms: string[]): string {
  const normalizedText = text.replace(/\s+/g, " ").trim();
  const lowerText = normalizedText.toLowerCase();
  const firstMatch = terms
    .map((term) => lowerText.indexOf(term))
    .filter((index) => index >= 0)
    .sort((a, b) => a - b)[0];

  if (firstMatch === undefined) {
    return normalizedText.slice(0, 1400);
  }

  const start = Math.max(0, firstMatch - 350);
  const end = Math.min(normalizedText.length, firstMatch + 1400);
  return normalizedText.slice(start, end);
}

function buildSemanticSnippet(text: string): string {
  return text.replace(/\s+/g, " ").trim().slice(0, 1400);
}

function splitIntoSections(page: KnowledgePage): KnowledgeSection[] {
  const blocks = page.text
    .split(/\n{2,}/)
    .map((block) => block.trim())
    .filter(Boolean);
  const sections: KnowledgeSection[] = [];
  let currentHeading = page.title.replace(/\s*\|\s*GEICO$/, "");
  let currentText: string[] = [];

  for (let index = 0; index < blocks.length; index += 1) {
    const block = blocks[index] ?? "";
    const nextBlock = blocks[index + 1];
    const isSectionHeading = isHeading(block, nextBlock);

    if (isSectionHeading && currentText.length > 0) {
      sections.push({
        title: page.title,
        sourceUrl: page.sourceUrl,
        fileName: page.fileName,
        heading: currentHeading,
        text: currentText.join("\n\n"),
      });
      currentHeading = block;
      currentText = [];
      continue;
    }

    if (isSectionHeading && currentText.length === 0) {
      currentHeading = block;
      continue;
    }

    currentText.push(block);
  }

  if (currentText.length > 0) {
    sections.push({
      title: page.title,
      sourceUrl: page.sourceUrl,
      fileName: page.fileName,
      heading: currentHeading,
      text: currentText.join("\n\n"),
    });
  }

  return sections.length > 0 ? sections : [{ ...page, heading: page.title }];
}

function isHeading(block: string, nextBlock?: string): boolean {
  if (block.length > 120) return false;
  if (/[.!]$/.test(block)) return false;
  const words = block.split(/\s+/);
  if (words.length > 14) return false;
  if (!/[a-z]/i.test(block)) return false;
  if (!/^[A-Z0-9"(/&'’?,: -]+$/i.test(block)) return false;

  // A heading should introduce body text. Short lines followed by more short
  // lines are usually list items, not section boundaries.
  return nextBlock ? isBodyBlock(nextBlock) : false;
}

function isBodyBlock(block: string): boolean {
  const normalizedBlock = block.trim();
  const words = normalizedBlock.split(/\s+/);
  return normalizedBlock.length > 120 || words.length > 16 || /[.!?]$/.test(normalizedBlock);
}

function expandTerms(baseTerms: string[]): string[] {
  const expanded = new Set(baseTerms);
  for (const term of baseTerms) {
    for (const synonym of synonymMap[term] ?? []) {
      expanded.add(synonym);
    }
  }

  return [...expanded].slice(0, 30);
}

function countOccurrences(text: string, term: string): number {
  let count = 0;
  let index = text.indexOf(term);

  while (index !== -1) {
    count += 1;
    index = text.indexOf(term, index + term.length);
  }

  return count;
}

function cosineSimilarity(a: number[], b: number[]): number {
  let dotProduct = 0;
  let aMagnitude = 0;
  let bMagnitude = 0;

  for (let index = 0; index < Math.min(a.length, b.length); index += 1) {
    dotProduct += a[index] * b[index];
    aMagnitude += a[index] * a[index];
    bMagnitude += b[index] * b[index];
  }

  if (aMagnitude === 0 || bMagnitude === 0) return 0;
  return dotProduct / (Math.sqrt(aMagnitude) * Math.sqrt(bMagnitude));
}
