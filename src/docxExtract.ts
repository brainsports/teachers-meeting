/**
 * DOCX text extraction for the document upload feature.
 * Uses jszip to unzip word/document.xml and pull out paragraph text.
 * The result is sent to /api/generate-teacher-minutes as plain text,
 * so the Gemini document flow works unchanged.
 * (Structure reused from brainsports/meeting — src/docxExtract.ts)
 */
import JSZip from 'jszip';

export async function extractDocxText(file: File): Promise<string> {
  const arrayBuffer = await file.arrayBuffer();
  const zip = await JSZip.loadAsync(arrayBuffer);

  const docXml = zip.file('word/document.xml');
  if (!docXml) {
    throw new Error('word/document.xml not found');
  }

  const xml = await docXml.async('string');

  return xml
    .replace(/<\/w:p>/g, '\n')
    .replace(/<w:tab[^>]*\/>/g, '\t')
    .replace(/<w:br[^>]*\/>/g, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, '&')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}
