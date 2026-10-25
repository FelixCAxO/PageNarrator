import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { createPdfPageModel } from '../../src/lib/pdf-page-model.js';
import { extractPdfTextFromDocument, iteratePdfSpeechChunks } from '../../src/lib/pdf-extraction.js';

const BOOK_VIEW = [0, 0, 439, 666];
const BODY_WORDS = ['alpha', 'bravo', 'charlie', 'delta', 'echo', 'foxtrot', 'golf', 'hotel', 'india', 'juliet'];

function createDocument(pages, view = BOOK_VIEW) {
  return {
    numPages: pages.length,
    async getPage(pageNumber) {
      return {
        view,
        async getTextContent() {
          return { items: pages[pageNumber - 1] };
        },
        cleanup() {},
      };
    },
  };
}

// Two body lines per page; each page's prose is unique.
function bookBody(pageNumber, top = 597) {
  const word = BODY_WORDS[pageNumber % BODY_WORDS.length];
  return [
    item(`The ${word} paragraph on page ${pageNumber} explains one idea in full`, 54, top, { width: 331 }),
    item(`and finishes the ${word} thought before the page ends.`, 54, top - 12, { width: 250 }),
  ];
}

// Even pages: page number left, chapter title right. Odd pages: section title
// left-aligned against the gutter, page number right.
function bookHeader(pageNumber, sectionTitle) {
  return pageNumber % 2 === 0
    ? [item(String(100 + pageNumber), 54, 623.3, { height: 8.5, width: 12.7 }),
      item('Garden Planning Workshop', 236, 623.3, { height: 8.5, width: 149 })]
    : [item(sectionTitle, 54, 623.3, { height: 8.5, width: sectionTitle.length * 4.4 }),
      item(String(100 + pageNumber), 372, 623.3, { height: 8.5, width: 12.7 })];
}

async function streamedSpeechByPage(document, options = {}) {
  const pages = new Map();
  for await (const chunk of iteratePdfSpeechChunks(document, options)) {
    pages.set(chunk.pageNumber, `${pages.get(chunk.pageNumber) || ''} ${chunk.speech}`.trim());
  }
  return pages;
}

// These authored fixtures retain recorded page geometry with synthetic prose
// and headings, so layout regressions do not depend on private document text.
function item(str, x, y, { height = 10, width = String(str).length * height * 0.5 } = {}) {
  return { str, transform: [height, 0, 0, height, x, y], width, height };
}

function spoken(items, pageView = [0, 0, 612, 792]) {
  return createPdfPageModel(items, { pageView }).speech;
}

describe('PDF table continuation rows', () => {
  it('merges a wrapped cell whose fragments align by left and right edges', () => {
    const items = [
      item('Name', 100, 700, { width: 100 }), item('Owner', 300, 700, { width: 60 }), item('Status', 500, 700, { width: 60 }),
      item('Design', 100, 670, { width: 100 }), item('Alice', 300, 670, { width: 60 }), item('Open', 500, 670, { width: 60 }),
      // Wrapped continuation: one fragment aligns by start, the next by end.
      item('and', 100, 660, { width: 50 }), item('docs', 176, 660, { width: 24 }),
      item('Review', 100, 640, { width: 100 }), item('Bob', 300, 640, { width: 60 }), item('Done', 500, 640, { width: 60 }),
    ];

    const model = createPdfPageModel(items, { pageView: [0, 0, 612, 792] });

    expect(model.orderedItems.map(({ str }) => str)).toEqual([
      'Name', 'Owner', 'Status', 'Design', 'and', 'docs', 'Alice', 'Open', 'Review', 'Bob', 'Done',
    ]);
  });
});

describe('PDF running headers learned from nearby pages', () => {
  const sections = ['Seedling Care', 'Seedling Care', 'Watering Schedules', 'Watering Schedules'];
  const pages = Array.from({ length: 8 }, (_, index) => {
    const pageNumber = index + 1;
    return [...bookHeader(pageNumber, sections[Math.floor(index / 2)] || 'Harvest Notes'), ...bookBody(pageNumber)];
  });

  it('drops alternating left and right page headers after the first page', async () => {
    const speech = await streamedSpeechByPage(createDocument(pages));

    for (const pageNumber of [2, 3, 4, 5, 6, 7, 8]) {
      expect(speech.get(pageNumber)).not.toMatch(/Garden Planning Workshop|Seedling Care|Watering Schedules|\b1\d\d\b/u);
      expect(speech.get(pageNumber)).toMatch(new RegExp(`^The ${BODY_WORDS[pageNumber % BODY_WORDS.length]} paragraph`, 'u'));
    }
  });

  it('drops a one-off section title typeset in a confirmed header slot', async () => {
    const oneOff = pages.map((page, index) => (index === 6
      ? [...bookHeader(7, 'Tool Storage'), ...bookBody(7)]
      : page));
    const speech = await streamedSpeechByPage(createDocument(oneOff));

    expect(speech.get(7)).not.toContain('Tool Storage');
    expect(speech.get(7)).toMatch(/^The hotel paragraph on page 7/u);
  });

  it('applies the same nearby-page detection to whole-document extraction', async () => {
    const article = await extractPdfTextFromDocument(createDocument(pages));

    for (const chunk of article.chunks.filter(({ pageNumber }) => pageNumber > 1)) {
      expect(chunk.speech).not.toMatch(/Garden Planning Workshop|Seedling Care|Watering Schedules/u);
    }
  });

  it('finds headers on cropped page boxes where the header sits just inside the text block', async () => {
    // Page box with wide margins: the header row is 67.6pt below the box top.
    const cropped = Array.from({ length: 6 }, (_, index) => [
      item(String(30 + index), 262.8, 697.4, { height: 9.5, width: 9.5 }),
      item('Planting Guide', 282.2, 697.4, { height: 9.5, width: 115.7 }),
      ...bookBody(index + 1, 681.3).map((line) => ({ ...line, transform: [10.9, 0, 0, 10.9, 271.7, line.transform[5]] })),
    ]);
    const speech = await streamedSpeechByPage(createDocument(cropped, [180, 99, 720, 765]));

    for (const pageNumber of [2, 3, 4, 5, 6]) {
      expect(speech.get(pageNumber)).not.toContain('Planting Guide');
    }
  });

  it('keeps body text that only shares its position and font with a header slot', async () => {
    // No isolated header: the first body line sits at the body line pitch.
    const bodyOnly = Array.from({ length: 6 }, (_, index) => bookBody(index + 1, 623.3)
      .map((line) => ({ ...line, height: 8.5, transform: [8.5, 0, 0, 8.5, 54, line.transform[5]] })));
    const speech = await streamedSpeechByPage(createDocument(bodyOnly));

    for (const pageNumber of [2, 3, 4, 5, 6]) {
      expect(speech.get(pageNumber)).toMatch(new RegExp(`^The ${BODY_WORDS[pageNumber % BODY_WORDS.length]} paragraph`, 'u'));
    }
  });
});

describe('PDF single-column pages without real column gutters', () => {
  it('keeps a justified row together when one sentence gap lands mid-page', () => {
    // A4 book page: one row is split into two text items by a wide sentence gap.
    const items = [
      item('The workshop team prepared a quiet corner for the spring seed trial.', 84, 297, { width: 424 }),
      item('Each marked tray stayed beside the window while the seedlings grew.', 84, 282, { width: 424 }),
      item('Mira checked the labels and recorded the first leaves.', 84, 268, { width: 201 }),
      item('Later, her partner measured the stems.', 293, 268, { width: 215 }),
      item('They compared the new results with a second tray beside the door.', 84, 254, { width: 424 }),
      item('The smaller plants received the same careful watering each morning.', 84, 239, { width: 424 }),
      item('Both trays stayed warm.', 84, 225, { width: 90 }),
      item('(Garden log)', 320, 210, { width: 80 }),
      item('A fresh notebook kept every measurement together for the next visit.', 84, 196, { width: 424 }),
    ];

    expect(spoken(items, [0, 0, 595, 842])).toContain(
      'Mira checked the labels and recorded the first leaves. Later, her partner measured the stems.',
    );
  });

  it('reads display equations and their numbers where they appear', () => {
    const items = [
      item('the scaled query-key offset is computed for every pair of tokens in the sequence', 84, 624, { width: 424 }),
      item('scaled query-key offset', 84, 610, { width: 101 }),
      item('PE(i, j) = -b(i - j)', 236, 584, { width: 120 }),
      item('= b(j - i)', 283, 567, { width: 64 }),
      item('(2.82)', 482, 567, { width: 26 }),
      item('where b is the scaling factor and the bias grows with the distance between tokens.', 84, 536, { width: 424 }),
      item('1', 313, 324, { width: 6 }),
      item('b k =', 269, 317, { width: 30 }),
      item('(2.84)', 482, 317, { width: 26 }),
      item('2 k 8', 310, 307, { width: 10 }),
      item('The approach provides a simple form of relative positional embeddings for models.', 101, 282, { width: 407 }),
    ];

    const speech = spoken(items, [0, 0, 595, 842]);
    expect(speech.indexOf('(2.82)')).toBeLessThan(speech.indexOf('where b is the scaling factor'));
    expect(speech.indexOf('(2.84)')).toBeLessThan(speech.indexOf('The approach provides'));
  });

  it('leaves a matrix figure above its caption out of narration', () => {
    const matrixRows = Array.from({ length: 6 }, (_, row) => [
      item(Array.from({ length: row + 1 }, (_, column) => `q${row}k${column}`).join(' '), 116, 718 - row * 22, { width: 22 * (row + 1), height: 7 }),
      item(Array.from({ length: row + 1 }, (_, column) => `u${row - column}`).join(' '), 333, 719 - row * 22, { width: 22 * (row + 1), height: 7 }),
    ]).flat();
    const items = [
      item('2.3 Long Sequence Modeling', 84, 779, { width: 129 }),
      item('87', 497, 779, { width: 11 }),
      ...matrixRows,
      item('(a) The bias matrices', 207, 556, { width: 168, height: 8 }),
      item('Fig. 2.11: Query-key products with biases above and below the diagonal.', 84, 520, { width: 424 }),
      item('layer stack. Rotary embeddings instead model positional context as rotations of', 84, 480, { width: 424 }),
      item('token embeddings in a complex space, which leads to a multiplicative model.', 84, 466, { width: 400 }),
    ];

    const speech = spoken(items, [0, 0, 595, 842]);
    expect(speech).not.toMatch(/q\dk\d|u\d u\d/u);
    expect(speech).toMatch(/Fig\. 2\.11: Query-key products[^]*layer stack\. Rotary embeddings/u);
  });
});

describe('PDF headings inside running text', () => {
  it('does not read a section heading before the paragraph that ends above it', () => {
    const items = [
      item('that generally normalized cross entropy adds weighting operations on the basis of', 54, 597, { width: 331 }),
      item('the cross entropy.', 54, 585, { width: 70 }),
      item('4.1.4 Neighborhood-Based Collaborative Filtering', 54, 541, { width: 257, height: 12 }),
      item('The deep collaborative filtering algorithms that have been introduced thus far in', 54, 513, { width: 331 }),
      item('this chapter all use the latent factor-based method for every model they describe.', 54, 501, { width: 331 }),
    ];

    expect(spoken(items, BOOK_VIEW)).toMatch(/^that generally normalized cross entropy[^]*the cross entropy\. 4\.1\.4 Neighborhood-Based/u);
  });
});

describe('PDF glyph-level producer artifacts', () => {
  it('drops hairline marker glyphs glued in front of inline math', () => {
    const items = [
      item('perform well due to its limited focus on merely the', 54, 393, { width: 300 }),
      { str: '.', transform: [6, 0, 0, 6, 355, 393], width: 0.7, height: 6 },
      item('k', 355.6, 393, { width: 4.6 }),
      item('neighbors, and as a result, it captures local information.', 362, 393, { width: 0 }),
    ];

    expect(spoken(items)).toContain('merely the k neighbors');
  });

  it('reads symbol-font bullets as list items', () => {
    const items = [
      item('Use the pattern when', 92, 796, { width: 127, height: 10.8 }),
      { str: 'l', transform: [5.4, 0, 0, 5.4, 112, 768], width: 4.3, height: 5.4 },
      item('the algorithm should be independent of the parts that make up the object.', 123, 768, { width: 420, height: 10.8 }),
      { str: 'l', transform: [5.4, 0, 0, 5.4, 112, 740], width: 4.3, height: 5.4 },
      item('the construction process must allow different representations.', 123, 740, { width: 360, height: 10.8 }),
    ];

    const speech = spoken(items, [0, 0, 595, 842]);
    expect(speech).not.toMatch(/\bl the\b/u);
    expect(speech).toContain('the algorithm should be independent of the parts that make up the object; the construction process');
  });

  it('joins touching word fragments split by font switches', () => {
    const fragments = [['Adds a', 23.3], ['n', 4.5], [' ', 0.3], ['optio', 18.3], ['n', 4.5], ['al ti', 13.7], ['m', 6.7], ['esta', 14.5], ['m', 6.7], ['p', 4.5]];
    let x = 356.6;
    const items = fragments.map(([str, width]) => {
      const part = item(str, str === ' ' ? x : x + (str === 'optio' ? 2 : 0), 160.6, { height: 9, width });
      x = part.transform[4] + width;
      return part;
    });

    expect(spoken(items)).toBe('Adds an optional timestamp.');
  });

  it('joins a paragraph first line whose indent is wider than two ems', () => {
    const items = [
      item('When the judgments are binary, i.e., relevant or not, re-', 299, 439, { width: 385, height: 10.9 }),
      item('searchers often refer to the training data as comprising pairs.', 272, 426, { width: 412, height: 10.9 }),
    ];

    expect(spoken(items)).toBe('When the judgments are binary, i.e., relevant or not, researchers often refer to the training data as comprising pairs.');
  });
});

describe('PDF reading order on recorded book page geometry', () => {
  const fixture = JSON.parse(readFileSync(new URL('../fixtures/pdf-dynamic-flow-pages.json', import.meta.url), 'utf8'));

  it.each(Object.keys(fixture.pages))('reads %s top to bottom without jumping back up', (name) => {
    const { view, items } = fixture.pages[name];
    const pdfItems = items.map(([str, scaleX, scaleY, x, y, width, height, hasEOL]) => ({
      str, transform: [scaleX, 0, 0, scaleY, x, y], width, height, hasEOL: Boolean(hasEOL),
    }));
    const model = createPdfPageModel(pdfItems, { pageView: view });
    const narrated = new Set(model.narratedOriginalIndices);
    const lines = model.lines.filter((line) => line.parts.some((part) => narrated.has(part.originalIndex)));
    const jumps = lines.slice(1).filter((line, index) => (
      line.y > lines[index].y + Math.max(...lines[index].parts.map((part) => part.height)) * 1.5
    ));

    expect(jumps.map((line) => line.text)).toEqual([]);
  });
});

describe('PDF margin side notes', () => {
  // Textbook layout: keyword glosses in the outer margin share baselines with
  // body lines and sit only 12pt from the text block.
  const body = (lines) => lines.map(([text, y, x = 142]) => item(text, x, y, { width: 475 - x, height: 10 }));
  const page = (notes) => [
    ...body([
      ['The two common tests used in this field are the approximate ran-', 565, 157],
      ['domization method and the bootstrap test, and we describe the', 553],
      ['paired version of each, which is most common in practice today.', 541],
      ['Paired tests compare two sets of observations that are aligned:', 530],
      ['each observation in one set is paired with one in the other set.', 517],
      ['This happens when two systems are compared on the same test set.', 506],
      ...Array.from({ length: 14 }, (_, index) => [`A full page of body text continues here with line ${index + 1} of the section.`, 482 - index * 12]),
    ]),
    item('48 Chapter 4 Logistic Regression', 77, 701, { width: 194, height: 10 }),
    ...notes,
  ];

  it('keeps keyword glosses out of the sentence they annotate', () => {
    const speech = spoken(page([
      item('approximate', 82, 565, { width: 48, height: 7 }),
      item('randomization', 76, 553, { width: 54, height: 7 }),
      item('paired', 104, 530, { width: 26, height: 7 }),
    ]));

    expect(speech).toContain('the approximate randomization method and the bootstrap test, and we describe the paired version');
    expect(speech).not.toMatch(/randomization approximate|paired Paired/u);
  });

  it('reads a margin note that adds new words after the text block', () => {
    const speech = spoken(page([
      item('see also', 96, 553, { width: 34, height: 7 }),
      item('resampling', 88, 541, { width: 42, height: 7 }),
    ]));

    expect(speech).toContain('the approximate randomization method and the bootstrap test, and we describe the paired version');
    expect(speech).toMatch(/same test set\.[^]*see also resampling/u);
  });

  it('does not treat hanging list numbers as side notes', () => {
    const speech = spoken([
      item('Before the list comes a full introductory sentence that spans the line.', 72, 700, { width: 420 }),
      ...['First step of the procedure is described here.', 'Second step follows the first one.', 'Third step completes it.']
        .flatMap((text, index) => [item(`${index + 1}.`, 80, 680 - index * 14, { width: 10 }), item(text, 96, 680 - index * 14, { width: 300 })]),
      ...Array.from({ length: 8 }, (_, index) => item(`Closing paragraph line number ${index + 1} continues the discussion here.`, 72, 620 - index * 14, { width: 420 })),
    ]);

    expect(speech).toContain('1. First step of the procedure is described here; 2. Second step follows the first one; 3. Third step completes it.');
  });
});

describe('PDF local column blocks above single-column text', () => {
  it('reads a keywords and abstract block column by column above a single-column body', () => {
    const abstract = [
      'Crop disease diagnosis from field photographs faces two recurring problems: models that score',
      'well on benchmarks frequently hallucinate species names, and when predictions are correct,',
      'the reasoning behind them is typically inaccessible to the practitioner. This paper describes',
      'a training-free framework in which a large model first generates a structured caption that',
      'is refined before any diagnostic question is answered, and the code is publicly available.',
    ];
    const keywords = ['Keywords:', 'Agricultural VQA', 'Crop Disease Diagnosis', 'Explainable AI', 'Vision-Language Models'];
    const items = [
      item('A Training-Free Framework for Agricultural Pest Diagnosis', 39, 677, { width: 466, height: 16 }),
      item('A R T I C L E I N F O', 39, 521, { width: 85 }),
      item('A B S T R A C T', 202, 520, { width: 64 }),
      ...keywords.map((text, index) => item(text, 39, 503 - index * 9.5, { width: text.length * 4.2, height: 8 })),
      ...abstract.map((text, index) => item(text, 202, 503 - index * 9.5, { width: 303, height: 8 })),
      item('1. Introduction', 39, 302, { width: 80, height: 10 }),
      ...Array.from({ length: 10 }, (_, index) => item(`Accurate diagnosis from field imagery requires two properties, line ${index + 1} of the body.`, 39, 286 - index * 12, { width: 466 })),
    ];

    const speech = spoken(items, [0, 0, 544, 742]);
    expect(speech).toContain('models that score well on benchmarks frequently hallucinate species names, and when predictions are correct, the reasoning behind them');
    expect(speech.indexOf('Vision-Language Models')).toBeLessThan(speech.indexOf('Crop disease diagnosis'));
  });

  it('reads a two-column definition table with wrapped cells row by row', () => {
    const rows = [
      ['all(it)', ['Returns True if all items in it are truthy, otherwise', 'False; all([]) returns True']],
      ['any(it)', ['Returns True if any item in it is truthy, otherwise', 'False; any([]) returns False']],
      ['max(it)', ['Returns the maximum value of the items in it; a key is', 'an ordering function, as in sorted']],
    ];
    let y = 340;
    const items = [
      ...Array.from({ length: 6 }, (_, index) => item(`An introductory paragraph line ${index + 1} explains the reducing functions here.`, 72, 500 - index * 13, { width: 360 })),
      item('Function', 76, 353, { width: 40 }), item('Description', 233, 353, { width: 50 }),
    ];
    for (const [name, description] of rows) {
      items.push(item(name, 76, y, { width: 35 }));
      description.forEach((text, index) => items.push(item(text, 233, y - index * 10, { width: 180 })));
      y -= 25;
    }
    items.push(...Array.from({ length: 4 }, (_, index) => item(`A closing paragraph line ${index + 1} follows the table and ends the section.`, 72, 240 - index * 13, { width: 360 })));

    const speech = spoken(items);
    expect(speech.indexOf('all(it)')).toBeLessThan(speech.indexOf('Returns True if all items'));
    expect(speech.indexOf('Returns True if all items')).toBeLessThan(speech.indexOf('any(it)'));
  });
});
