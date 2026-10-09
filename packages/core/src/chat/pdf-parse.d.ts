/**
 * pdf-parse 1.x 主入口带有“被直接执行时解析示例文件”的调试逻辑，
 * 因此代码统一从 lib 子路径引入；该子路径没有官方类型，这里补最小声明。
 */
declare module 'pdf-parse/lib/pdf-parse.js' {
  interface PdfParseResult {
    text: string
    numpages?: number
  }
  function pdfParse(buffer: Buffer): Promise<PdfParseResult>
  export default pdfParse
}
