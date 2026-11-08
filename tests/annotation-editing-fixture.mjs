import { PDFDocument, PDFName, PDFHexString, StandardFonts, rgb } from 'pdf-lib';

// Original, deterministic test document. It contains no external document text.
// Native annotations are authored directly as standard PDF objects, independently
// of the application's annotation exporter.
export async function buildAnnotationEditingFixture({ native = 'none', title = 'Annotation editing laboratory' } = {}) {
  const pdf = await PDFDocument.create();
  pdf.setTitle(title); pdf.setAuthor('ADHD Reader test fixture');
  pdf.setCreationDate(new Date('2025-01-01T00:00:00Z')); pdf.setModificationDate(new Date('2025-01-01T00:00:00Z'));
  const font = await pdf.embedFont(StandardFonts.Helvetica);
  const pages = [], annotations = [];
  const sentences = [
    'The morning light reaches the quiet garden.',
    'A paper boat travels past the wooden bridge.',
    'Three small stones mark the beginning of the path.',
    'A blue notebook rests beside the open window.',
    'The kettle becomes silent after the water boils.',
    'Several leaves gather beneath the empty bench.',
    'A short comment can preserve a useful question.',
    'The next paragraph introduces a different thought.',
    'Two transparent layers share this single sentence.',
    'A patient reader returns to the same clear place.',
    'The afternoon clouds move beyond the distant hill.',
    'A narrow stream follows the edge of the meadow.',
    'These original sentences support a repeatable test.',
    'The final line leaves room for the following page.',
  ];
  for (let pageIndex = 0; pageIndex < 2; pageIndex++) {
    const page = pdf.addPage([612, 900]);
    page.drawText(`${title} - ${pageIndex + 1}`, { x: 64, y: 844, size: 18, font });
    const rows = sentences.map((sentence, row) => {
      const text = `P${pageIndex + 1} L${String(row + 1).padStart(2, '0')}  ${sentence}`;
      const item = { pageIndex, row, text, x: 64, y: 790 - row * 38, size: 12, width: font.widthOfTextAtSize(text, 12) };
      page.drawText(text, { x: item.x, y: item.y, size: item.size, font, color: rgb(.05, .05, .05) });
      return item;
    });
    pages.push({ width: 612, height: 900, rows });
  }
  const rectForRow = row => [64, pages[0].rows[row].y - 3, 500, pages[0].rows[row].y + 13];
  function addAnnotation({ name, subtype, rects, color = [1, .88, .35], contents = name, pageIndex = 0 }) {
    const page = pdf.getPage(pageIndex), context = pdf.context;
    const bound = [Math.min(...rects.map(r => r[0])), Math.min(...rects.map(r => r[1])), Math.max(...rects.map(r => r[2])), Math.max(...rects.map(r => r[3]))];
    const width = bound[2] - bound[0], height = bound[3] - bound[1];
    const alpha = subtype === 'Highlight' ? .35 : 1;
    let operators = `q /GS0 gs ${color.join(' ')} rg ${color.join(' ')} RG\n`;
    for (const rect of rects) {
      const x = rect[0] - bound[0], y = rect[1] - bound[1], w = rect[2] - rect[0], h = rect[3] - rect[1];
      operators += subtype === 'Underline' ? `1 w ${x} ${y + 1} m ${x + w} ${y + 1} l S\n` : `${x} ${y} ${w} ${h} re f\n`;
    }
    operators += 'Q';
    const appearance = context.register(context.flateStream(operators, {
      Type: 'XObject', Subtype: 'Form', BBox: [0, 0, width, height],
      Resources: { ExtGState: { GS0: { Type: 'ExtGState', ca: alpha, CA: alpha } } },
    }));
    const dictionary = context.obj({ Type: 'Annot', Subtype: subtype, Rect: bound, P: page.ref, F: 4,
      NM: PDFHexString.fromText(name), T: PDFHexString.fromText('Fixture author'), Contents: PDFHexString.fromText(contents),
      C: color, CA: alpha, AP: { N: appearance } });
    if (subtype === 'Highlight' || subtype === 'Underline') dictionary.set(PDFName.of('QuadPoints'), context.obj(rects.flatMap(([x1,y1,x2,y2]) => [x1,y2,x2,y2,x1,y1,x2,y1])));
    if (subtype === 'Text') dictionary.set(PDFName.of('Name'), PDFName.of('Comment'));
    page.node.addAnnot(context.register(dictionary));
    annotations.push({ name, subtype, pageIndex, rects, contents, color });
  }
  if (native === 'standard') {
    addAnnotation({ name: 'native-highlight', subtype: 'Highlight', rects: [rectForRow(1), rectForRow(2)], contents: 'Original multiline highlight' });
    addAnnotation({ name: 'native-underline', subtype: 'Underline', rects: [rectForRow(4)], color: [0, 0, 0] });
    const y = pages[0].rows[6].y;
    addAnnotation({ name: 'native-comment', subtype: 'Text', rects: [[510, y - 3, 528, y + 15]], contents: '原有评论：保留、撤销与删除。', color: [1, .8, .2] });
  } else if (native === 'overlap') {
    addAnnotation({ name: 'overlap-first', subtype: 'Highlight', rects: [rectForRow(8)], color: [1, .88, .35] });
    addAnnotation({ name: 'overlap-second', subtype: 'Highlight', rects: [rectForRow(8)], color: [.5, .8, 1] });
  }
  if (native !== 'none') {
    const page = pdf.getPage(0), context = pdf.context;
    page.node.addAnnot(context.register(context.obj({ Type: 'Annot', Subtype: 'Link', Rect: [510, 790, 540, 810], Border: [0,0,0],
      NM: PDFHexString.fromText('untouched-link'), A: { S: 'URI', URI: PDFHexString.fromText('https://example.invalid/fixture') } })));
  }
  return { bytes: await pdf.save(), pages, annotations };
}
