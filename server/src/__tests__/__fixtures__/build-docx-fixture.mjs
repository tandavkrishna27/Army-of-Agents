// server/src/__tests__/__fixtures__/build-docx-fixture.mjs
import JSZip from "jszip";
import { writeFileSync } from "node:fs";

const zip = new JSZip();

zip.file("[Content_Types].xml",
`<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
  <Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
  <Default Extension="xml" ContentType="application/xml"/>
  <Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>
</Types>`);

zip.file("_rels/.rels",
`<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/>
</Relationships>`);

zip.file("word/_rels/document.xml.rels",
`<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rIdJS" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/hyperlink" Target="javascript:alert(1)" TargetMode="External"/>
  <Relationship Id="rIdSafe" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/hyperlink" Target="https://example.com" TargetMode="External"/>
</Relationships>`);

zip.file("word/document.xml",
`<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"
            xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">
  <w:body>
    <w:p><w:hyperlink r:id="rIdJS"><w:r><w:t>click me</w:t></w:r></w:hyperlink></w:p>
    <w:p><w:hyperlink r:id="rIdSafe"><w:r><w:t>safe link</w:t></w:r></w:hyperlink></w:p>
  </w:body>
</w:document>`);

const buf = await zip.generateAsync({ type: "nodebuffer" });
writeFileSync(new URL("./docx-with-javascript-href.docx", import.meta.url), buf);
console.log("wrote fixture");
