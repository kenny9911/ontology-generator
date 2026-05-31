// pdf-parse ships no type declarations. We only use the
// (dataBuffer, options) -> { text, numpages } surface plus the `pagerender`
// option, so a minimal ambient module declaration suffices.
declare module 'pdf-parse' {
  interface PDFData {
    text: string;
    numpages: number;
    info: Record<string, unknown>;
  }
  function pdfParse(dataBuffer: Buffer, options?: Record<string, unknown>): Promise<PDFData>;
  export default pdfParse;
}
