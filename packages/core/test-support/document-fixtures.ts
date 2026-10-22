/** 自有最小文档夹具，不依赖用户文件、远程下载或 Office。 */
export function pdfFixture(pages = ['Axon first page', 'Axon second page']): Buffer {
  const font = 3 + pages.length * 2
  const objects = ['<< /Type /Catalog /Pages 2 0 R >>', `<< /Type /Pages /Kids [${pages.map((_, index) => `${3 + index * 2} 0 R`).join(' ')}] /Count ${pages.length} >>`]
  for (const [index, text] of pages.entries()) {
    const stream = `BT /F1 12 Tf 36 160 Td (${text.replaceAll('\\', '\\\\').replaceAll('(', '\\(').replaceAll(')', '\\)')}) Tj ET`
    objects.push(`<< /Type /Page /Parent 2 0 R /MediaBox [0 0 300 200] /Resources << /Font << /F1 ${font} 0 R >> >> /Contents ${4 + index * 2} 0 R >>`, `<< /Length ${Buffer.byteLength(stream, 'latin1')} >>\nstream\n${stream}\nendstream`)
  }
  objects.push('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>')
  let result = '%PDF-1.4\n%Axon fixture\n'
  const offsets = [0]
  for (const [index, object] of objects.entries()) { offsets.push(Buffer.byteLength(result, 'latin1')); result += `${index + 1} 0 obj\n${object}\nendobj\n` }
  const xref = Buffer.byteLength(result, 'latin1')
  result += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n${offsets.slice(1).map((offset) => `${String(offset).padStart(10, '0')} 00000 n \n`).join('')}trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`
  return Buffer.from(result, 'latin1')
}

/** ZIP stored 条目用于 DOCX；目录/CRC 完整，解析测试不借用解析库自己的内部写入接口。 */
export function zipFixture(files: Record<string, string>): Buffer {
  const locals: Buffer[] = [], central: Buffer[] = []
  let offset = 0
  for (const [filename, text] of Object.entries(files)) {
    const name = Buffer.from(filename), content = Buffer.from(text)
    let crc = 0xffffffff
    for (const byte of content) { crc ^= byte; for (let bit = 0; bit < 8; bit += 1) crc = crc >>> 1 ^ (crc & 1 ? 0xedb88320 : 0) }
    crc = (crc ^ 0xffffffff) >>> 0
    const local = Buffer.alloc(30), record = Buffer.alloc(46)
    local.writeUInt32LE(0x04034b50); local.writeUInt16LE(20, 4); local.writeUInt32LE(crc, 14)
    local.writeUInt32LE(content.length, 18); local.writeUInt32LE(content.length, 22); local.writeUInt16LE(name.length, 26)
    record.writeUInt32LE(0x02014b50); record.writeUInt16LE(20, 4); record.writeUInt16LE(20, 6); record.writeUInt32LE(crc, 16)
    record.writeUInt32LE(content.length, 20); record.writeUInt32LE(content.length, 24); record.writeUInt16LE(name.length, 28); record.writeUInt32LE(offset, 42)
    locals.push(local, name, content); central.push(record, name); offset += local.length + name.length + content.length
  }
  const directory = Buffer.concat(central), end = Buffer.alloc(22)
  end.writeUInt32LE(0x06054b50); end.writeUInt16LE(central.length / 2, 8); end.writeUInt16LE(central.length / 2, 10)
  end.writeUInt32LE(directory.length, 12); end.writeUInt32LE(offset, 16)
  return Buffer.concat([...locals, directory, end])
}

export function docxFixture(): Buffer {
  return zipFixture({
    '[Content_Types].xml': '<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>',
    '_rels/.rels': '<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="r1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>',
    'word/document.xml': '<?xml version="1.0"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:p><w:r><w:t>Axon 正文 &amp; 内容</w:t></w:r></w:p><w:tbl><w:tr><w:tc><w:p><w:r><w:t>名称</w:t></w:r></w:p></w:tc><w:tc><w:p><w:r><w:t>数量</w:t></w:r></w:p></w:tc></w:tr><w:tr><w:tc><w:p><w:r><w:t>附件</w:t></w:r></w:p></w:tc><w:tc><w:p><w:r><w:t>2</w:t></w:r></w:p></w:tc></w:tr></w:tbl><w:p><w:r><w:t>末尾段落</w:t></w:r></w:p></w:body></w:document>',
  })
}
