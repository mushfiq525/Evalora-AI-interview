import { PDFParse } from 'pdf-parse';
import mammoth from 'mammoth';

const isPdf = (b) => b.subarray(0, 4).toString() === '%PDF';
const isZip = (b) => b[0] === 0x50 && b[1] === 0x4b; // DOCX is a ZIP

/** Extract plain text from a PDF, DOCX or TXT upload. File type is checked from content, not the name. */
export async function extractCvText(file) {
  const { buffer, originalname = '' } = file;
  let text = '';

  if (isPdf(buffer)) {
    const parser = new PDFParse({ data: new Uint8Array(buffer) });
    try {
      text = (await parser.getText()).text;
    } finally {
      await parser.destroy();
    }
  } else if (isZip(buffer) && originalname.toLowerCase().endsWith('.docx')) {
    text = (await mammoth.extractRawText({ buffer })).value;
  } else if (originalname.toLowerCase().endsWith('.txt')) {
    text = buffer.toString('utf8');
  } else {
    throw new Error('Unsupported file. Upload a PDF, DOCX or TXT CV.');
  }

  return text
    .replace(/\r/g, '')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}
