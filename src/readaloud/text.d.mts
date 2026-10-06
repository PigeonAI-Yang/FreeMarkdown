export interface Paragraph { text: string; line: number; chunk: number; tag: string }
export function paragraphs(chunks: string[]): Generator<Paragraph>;
export function sentences(text: string): string[];
