/** 打包验证用合法文档；不依赖包外解析器，正文必须由实际子端提取。 */
export function packagedPdf(): Buffer {
  const content = 'BT /F1 24 Tf 72 720 Td (Axon packaged PDF) Tj ET'
  const objects = ['<< /Type /Catalog /Pages 2 0 R >>', '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>',
    `<< /Length ${content.length} >>\nstream\n${content}\nendstream`, '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>']
  let body = '%PDF-1.4\n'
  const offsets: number[] = []
  objects.forEach((object, index) => { offsets.push(body.length); body += `${index + 1} 0 obj\n${object}\nendobj\n` })
  const xref = body.length
  body += `xref\n0 6\n0000000000 65535 f \n${offsets.map((offset) => `${String(offset).padStart(10, '0')} 00000 n \n`).join('')}`
  return Buffer.from(body + `trailer\n<< /Size 6 /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF`, 'latin1')
}

/** 生成无需压缩的标准 ZIP/DOCX，保留 CRC 和中央目录，避免非法文件掩盖加载失败。 */
export function packagedDocx(): Buffer {
  const files = {
    '[Content_Types].xml': '<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>',
    '_rels/.rels': '<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>',
    'word/document.xml': '<?xml version="1.0"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:p><w:r><w:t>Axon packaged DOCX</w:t></w:r></w:p></w:body></w:document>',
  }
  const local: Buffer[] = [], central: Buffer[] = []
  let offset = 0
  for (const [name, value] of Object.entries(files)) {
    const filename = Buffer.from(name), data = Buffer.from(value)
    let checksum = 0xffffffff
    for (const byte of data) {
      checksum ^= byte
      for (let bit = 0; bit < 8; bit += 1) checksum = checksum >>> 1 ^ (checksum & 1 ? 0xedb88320 : 0)
    }
    checksum = (checksum ^ 0xffffffff) >>> 0
    const header = Buffer.alloc(30)
    header.writeUInt32LE(0x04034b50); header.writeUInt16LE(20, 4); header.writeUInt32LE(checksum, 14)
    header.writeUInt32LE(data.length, 18); header.writeUInt32LE(data.length, 22); header.writeUInt16LE(filename.length, 26)
    const entry = Buffer.alloc(46)
    entry.writeUInt32LE(0x02014b50); entry.writeUInt16LE(20, 4); entry.writeUInt16LE(20, 6)
    entry.writeUInt32LE(checksum, 16); entry.writeUInt32LE(data.length, 20); entry.writeUInt32LE(data.length, 24)
    entry.writeUInt16LE(filename.length, 28); entry.writeUInt32LE(offset, 42)
    local.push(header, filename, data); central.push(entry, filename)
    offset += header.length + filename.length + data.length
  }
  const end = Buffer.alloc(22), directory = Buffer.concat(central)
  end.writeUInt32LE(0x06054b50); end.writeUInt16LE(3, 8); end.writeUInt16LE(3, 10)
  end.writeUInt32LE(directory.length, 12); end.writeUInt32LE(offset, 16)
  return Buffer.concat([...local, directory, end])
}
