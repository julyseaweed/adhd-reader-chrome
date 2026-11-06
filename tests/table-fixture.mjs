import { PDFDocument, StandardFonts, rgb } from 'pdf-lib';

// Authored PDF coordinates and reading order are independent of the detector.
// Cell text is deliberately retained in the file and in the expected inventory.
export async function buildTableFixture() {
  const pdf = await PDFDocument.create();
  const regular = await pdf.embedFont(StandardFonts.TimesRoman);
  const bold = await pdf.embedFont(StandardFonts.TimesRomanBold);
  const italic = await pdf.embedFont(StandardFonts.TimesRomanItalic);
  const cases = [], width = 612, height = 792;
  const sheet = name => { const page = pdf.addPage([width, height]); const data = { name, width, height, order: [], cells: [] }; cases.push(data); return { page, data }; };
  const text = (target, value, x, y, size = 11, font = regular, cell = false) => {
    const item = { text: value, x, y, size, width: font.widthOfTextAtSize(value, size) };
    target.page.drawText(value, { x, y, size, font });
    (cell ? target.data.cells : target.data.order).push(item); return item;
  };
  const rule = (target, x1, y1, x2, y2, thickness = .55) => target.page.drawLine({ start: { x: x1, y: y1 }, end: { x: x2, y: y2 }, thickness, color: rgb(0, 0, 0) });
  for (const [index, type] of ['bordered', 'three-rule', 'borderless-text'].entries()) {
    const target = sheet(type);
    text(target, 'This paragraph introduces the comparison before its supporting data.', 54, 740);
    text(target, 'Its second sentence remains part of the ordinary reading sequence.', 54, 724);
    text(target, type === 'borderless-text' ? 'Collection overview and observed behavior' : `Table ${index + 1}: Outcomes across the experimental conditions.`, 54, 682, 11, bold);
    const rows = type === 'borderless-text'
      ? [['Regime', 'Strategy', 'Behavior'], ['Reference', 'Direct', 'Stable'], ['Balanced', 'Adaptive', 'Smooth'], ['Combined', 'Sequential', 'Consistent'], ['Control', 'Independent', 'Variable']]
      : [['Condition', 'Accuracy', 'Trials'], ['Baseline', '82.4', '150'], ['Augmented', '89.1', '150'], ['Combined', '93.7', '200'], ['Control', '76.2', '120']];
    for (let row = 0; row < rows.length; row++) for (let col = 0; col < 3; col++)
      text(target, rows[row][col], [72, 246, 414][col], 637 - row * 29, row ? 10.5 : 11, row ? regular : bold, true);
    target.data.tableBounds = { x: 60, y: 505, width: 492, height: 149 };
    target.data.blankPoint = { x: 356, y: 595 };
    if (type !== 'borderless-text') {
      for (const y of type === 'bordered' ? [654, 625, 596, 567, 538, 505] : [654, 625, 505]) rule(target, 60, y, 552, y, y === 654 || y === 505 ? .8 : .45);
      if (type === 'bordered') for (const x of [60, 234, 402, 552]) rule(target, x, 505, x, 654);
    }
    text(target, 'Note: Each condition uses a separate set of observations.', 54, 476, 10, italic);
    text(target, 'Repeated observations were combined before the comparison.', 54, 461, 10, italic);
    text(target, 'The following paragraph interprets the comparison in ordinary prose.', 54, 421);
    text(target, 'Reading continues here after the complete table and its notes.', 54, 405);
  }

  const mixed = sheet('two-columns-with-local-table');
  for (const [index, value] of [
    'The left column introduces its comparison.',
    'This sentence explains the local evidence.',
    'The next line continues the same account.',
    'A small table supports the discussion.'
  ].entries()) text(mixed, value, 42, 742 - index * 16, 10);
  text(mixed, 'Table 4: Results within the left column.', 42, 652, 10, bold);
  const values = [['Method', 'Score', 'State'], ['Amber', '0.82', 'Stable'], ['Birch', '0.91', 'Smooth'], ['Cedar', '0.88', 'Steady']];
  for (let row = 0; row < values.length; row++) for (let col = 0; col < 3; col++)
    text(mixed, values[row][col], [50, 144, 214][col], 614 - row * 30, row ? 9 : 9.5, row ? regular : bold, true);
  for (const y of [630, 600, 508]) rule(mixed, 42, y, 280, y);
  mixed.data.tableBounds = { x: 42, y: 508, width: 238, height: 122 };
  mixed.data.blankPoint = { x: 196, y: 568 };
  text(mixed, 'Note: All entries use the same conditions.', 42, 480, 9.5, italic);
  text(mixed, 'The sample size is constant across groups.', 42, 465, 9.5, italic);
  for (const [index, value] of [
    'The discussion then resumes in this column.',
    'Its interpretation follows the retained note.',
    'Only after this paragraph does reading move',
    'to the independent column on the right.'
  ].entries()) text(mixed, value, 42, 430 - index * 16, 10);
  for (const [index, word] of ['First', 'Second', 'Third', 'Fourth', 'Fifth', 'Sixth', 'Seventh', 'Eighth', 'Ninth', 'Tenth', 'Next', 'Final'].entries())
    text(mixed, `${word}, the right paragraph continues here.`, 326, 742 - index * 22, 10);

  const columns = sheet('negative-two-prose-columns');
  for (const [column, x] of [[0, 42], [1, 326]]) for (let row = 0; row < 6; row++)
    text(columns, `${column ? 'Right' : 'Left'} paragraph line ${row + 1} continues its story.`, x, 742 - row * 18, 10);

  const matrix = sheet('negative-matrix');
  text(matrix, 'A matrix remains a mathematical reading unit.', 54, 742);
  const unit = text(matrix, 'M =', 110, 632, 12);
  const points = [{ x: 120, y: 636 }];
  for (const [x, direction] of [[177, 1], [274, -1]]) {
    rule(matrix, x, 602, x, 674); rule(matrix, x, 674, x + direction * 7, 674); rule(matrix, x, 602, x + direction * 7, 602);
  }
  for (let row = 0; row < 3; row++) for (let col = 0; col < 3; col++) {
    const x = 193 + col * 27, y = 657 - row * 22;
    matrix.page.drawText(String(row === col ? 1 : 0), { x, y, size: 12, font: regular });
    points.push({ x: x + 3, y: y + 4 });
  }
  matrix.page.drawText('v', { x: 285, y: 632, size: 12, font: italic }); points.push({ x: 288, y: 636 });
  unit.points = points;
  text(matrix, 'The paragraph below the matrix also remains readable.', 54, 556);

  const only = sheet('table-only');
  const rows = [['Condition', 'Accuracy', 'Trials'], ['Baseline', '82.4', '150'], ['Augmented', '89.1', '150'], ['Combined', '93.7', '200'], ['Control', '76.2', '120']];
  for (let row = 0; row < rows.length; row++) for (let col = 0; col < 3; col++)
    text(only, rows[row][col], [72, 246, 414][col], 637 - row * 29, 11, row ? regular : bold, true);
  for (const y of [654, 625, 596, 567, 538, 505]) rule(only, 60, y, 552, y);
  for (const x of [60, 234, 402, 552]) rule(only, x, 505, x, 654);
  only.data.tableBounds = { x: 60, y: 505, width: 492, height: 149 }; only.data.blankPoint = { x: 356, y: 595 };
  const after = sheet('prose-after-table-only');
  text(after, 'Reading resumes after the page containing only a table.', 54, 742);
  text(after, 'This second line confirms the regular sequence continues.', 54, 724);

  const boxed = sheet('boxed-table-with-retained-notes');
  text(boxed, 'The paragraph before this table remains readable.', 54, 740);
  text(boxed, 'Table 5: A comparison whose notes share the outer border.', 54, 682, 11, bold);
  for (let row = 0; row < rows.length; row++) for (let col = 0; col < 3; col++)
    text(boxed, rows[row][col], [72, 246, 414][col], 637 - row * 29, 11, row ? regular : bold, true);
  for (const y of [654, 625, 596, 567, 538, 505, 445]) rule(boxed, 60, y, 552, y);
  for (const x of [60, 552]) rule(boxed, x, 445, x, 654);
  for (const x of [234, 402]) rule(boxed, x, 505, x, 654);
  text(boxed, 'Note: This sentence is inside the same outer border as the data.', 72, 476, 10, italic);
  text(boxed, 'Its continuation must remain available to the reading navigator.', 72, 461, 10, italic);
  text(boxed, 'The paragraph after the boxed notes continues normally.', 54, 405);
  boxed.data.tableBounds = { x: 60, y: 505, width: 492, height: 149 }; boxed.data.blankPoint = { x: 356, y: 595 };
  return { bytes: await pdf.save({ useObjectStreams: false }), cases };
}
