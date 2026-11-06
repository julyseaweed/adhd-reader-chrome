import { PDFDocument, StandardFonts } from 'pdf-lib';

// Expected order is authored here, independently of extraction or layout code.
// Content-stream order deliberately alternates columns; visual reading order
// must finish a column before continuing with the next one.
export async function buildColumnFixture() {
  const pdf = await PDFDocument.create();
  const font = await pdf.embedFont(StandardFonts.TimesRoman);
  const bold = await pdf.embedFont(StandardFonts.TimesRomanBold);
  const size = { width: 612, height: 792 };
  const cases = [];
  const names = ['Amber', 'Birch', 'Cedar', 'Dawn', 'Elm', 'Fern'];
  const ordinals = ['one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight'];
  function sheet(name) {
    const page = pdf.addPage([size.width, size.height]);
    const item = { name, size, order: [] };
    cases.push(item);
    return { page, item };
  }
  function columns(target, { xs, ys, fontSize = 9, prefix = '', rows = 6, words = 'quiet words continue.' }) {
    const groups = xs.map((x, column) => Array.from({ length: Array.isArray(rows) ? rows[column] : rows }, (_, index) => {
      const text = `${prefix}${names[column]} ${ordinals[index]} ${words}`;
      return { text, x, y: Array.isArray(ys[column]) ? ys[column][index] : ys[index],
        size: fontSize, width: font.widthOfTextAtSize(text, fontSize), column };
    }));
    target.item.order.push(...groups.flat());
    for (let row = 0; row < Math.max(...groups.map(group => group.length)); row++) {
      for (const group of [...groups].reverse()) {
        const line = group[row];
        if (line) target.page.drawText(line.text, { x: line.x, y: line.y, size: line.size, font });
      }
    }
  }
  function spanning(target, text, y, fontSize = 12) {
    const line = { text, x: 38, y, size: fontSize, width: bold.widthOfTextAtSize(text, fontSize), column: null };
    target.item.order.push(line);
    target.page.drawText(text, { x: line.x, y, size: fontSize, font: bold });
  }
  const two = sheet('two-columns-uneven-paragraphs');
  columns(two, { xs: [48, 328], fontSize: 10,
    ys: [[714, 698, 682, 618, 602, 586, 570], [705, 689, 673, 657, 641, 625]], rows: [7, 6],
    words: 'the paragraph stays in this column.' });

  const three = sheet('three-columns-paragraph-gaps');
  columns(three, { xs: [38, 228, 418], fontSize: 8.5,
    ys: [[714, 699, 684, 615, 600, 585], [710, 695, 680, 665, 650, 635], [714, 699, 684, 624, 609, 594]] });

  const four = sheet('four-columns-uneven-gutters');
  columns(four, { xs: [30, 181, 323, 470], fontSize: 8,
    ys: [[714, 699, 684, 624, 609, 594], [706, 691, 676, 661, 646, 631],
      [714, 699, 684, 669, 654, 639], [710, 695, 680, 620, 605, 590]], words: 'words keep flowing.' });

  const five = sheet('five-columns-staggered-paragraphs');
  columns(five, { xs: [28, 141, 254, 367, 480], fontSize: 7.4,
    ys: [[714, 701, 688, 632, 619, 606], [710, 697, 684, 671, 658, 645],
      [714, 701, 688, 675, 662, 649], [710, 697, 684, 630, 617, 604],
      [714, 701, 688, 675, 662, 649]], words: 'words flow here.' });

  const mixed = sheet('spanning-heading-between-column-sections');
  spanning(mixed, 'Reading begins with this full width introduction across every column on the entire page.', 738, 13);
  columns(mixed, { xs: [44, 328], ys: [[704, 688, 672, 656], [700, 684, 668, 652]], rows: 4,
    fontSize: 10, prefix: 'Upper ', words: 'the paragraph continues.' });
  spanning(mixed, 'The middle heading spans the complete page and starts a new section for every column.', 610, 13);
  columns(mixed, { xs: [38, 228, 418], ys: [[572, 557, 542, 527], [568, 553, 538, 523], [572, 557, 542, 527]],
    rows: 4, fontSize: 8.5, prefix: 'Lower ', words: 'words continue.' });
  spanning(mixed, 'The final full width paragraph follows every column and finishes the complete reading section.', 478, 12);

  const transition = sheet('two-columns-to-four-columns');
  columns(transition, { xs: [44, 328], ys: [714, 698, 682, 666], rows: 4,
    fontSize: 10, prefix: 'Upper ', words: 'the paragraph continues.' });
  spanning(transition, 'A full width section boundary introduces four independent columns across the complete page.', 618, 12.5);
  columns(transition, { xs: [30, 181, 323, 470], ys: [576, 562, 548, 534], rows: 4,
    fontSize: 7.8, prefix: 'Lower ', words: 'words flow.' });

  const partial = sheet('partial-spanning-heading-keeps-third-column-continuous');
  columns(partial, { xs: [38, 220], ys: [714, 698, 682], rows: 3, fontSize: 8.5,
    prefix: 'Upper ', words: 'the words continue.' });
  spanning(partial, 'A shared heading for the first two columns', 646, 11);
  columns(partial, { xs: [38, 220], ys: [614, 598, 582], rows: 3, fontSize: 8.5,
    prefix: 'Lower ', words: 'the words continue.' });
  columns(partial, { xs: [420], ys: [714, 698, 682, 666, 650, 634, 618, 602], rows: 8,
    fontSize: 8.5, prefix: 'Far ', words: 'the words continue.' });

  const local = sheet('short-local-heading-equation-indent-and-paragraph-tail');
  const localLines = [
    ['The first paragraph remains in the left column.', 44, 714, 10],
    ['Its next line continues the same explanation.', 44, 698, 10],
    ['A brief ending.', 44, 682, 10],
    ['Local section heading', 44, 646, 11, true],
    ['An indented paragraph begins another thought.', 60, 622, 9.5],
    ['f(x) = x + 1', 90, 604, 11],
    ['This explanation follows the short equation.', 44, 584, 10],
    ['The final line completes the first column.', 44, 568, 10],
  ];
  for (const [text, x, y, fontSize, isBold] of localLines) {
    const actualFont = isBold ? bold : font;
    local.item.order.push({ text, x, y, size: fontSize, width: actualFont.widthOfTextAtSize(text, fontSize), column: 0 });
    local.page.drawText(text, { x, y, size: fontSize, font: actualFont });
  }
  columns(local, { xs: [328], ys: [710, 694, 678, 662, 646, 630, 614, 598], rows: 8,
    fontSize: 10, prefix: 'Right ', words: 'this paragraph keeps its place.' });

  const tails = sheet('short-paragraph-tails-in-neighboring-columns');
  for (const [column, x] of [44, 328].entries()) {
    const texts = column ? ['The second column starts its own discussion.', 'The paragraph continues with related details.', 'Details.',
      'A new paragraph follows within this column.', 'Its explanation has another short ending.', 'More follows:', 'The final sentence concludes the right column.']
      : ['The first column begins an independent account.', 'Its second line continues the current subject.', 'This full sentence stays separate from the right.',
        'The next paragraph still belongs to the left.', 'Its continuation also belongs to this column.', 'This line must not absorb a short neighbor.', 'Only after this line should the next column begin.'];
    for (const [index, text] of texts.entries()) {
      const y = [714, 698, 682, 650, 634, 618, 602][index], fontSize = 10;
      tails.item.order.push({ text, x, y, size: fontSize, width: font.widthOfTextAtSize(text, fontSize), column });
      tails.page.drawText(text, { x, y, size: fontSize, font });
    }
  }
  return { bytes: await pdf.save({ useObjectStreams: false }), size, cases };
}
