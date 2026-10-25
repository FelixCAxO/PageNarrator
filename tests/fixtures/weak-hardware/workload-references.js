// Independently authored reference text for weak-hardware probe workloads.
// The HTML fixtures are generated from these same records, so extraction is
// scored against what the author wrote, never against extractor output.

// Two pages force a real PDF section handoff in measurement contract 3.
export const TTS_PROBE_PDF_PAGES = Object.freeze([
  Object.freeze([
    'PageNarrator hardware probe first page.',
    'This local PDF keeps its text selectable while the reader speaks every sentence aloud.',
    'Page transitions keep the voice moving, with words highlighted in reading order.',
    'Reader settings preserve the selected voice and speed while the audio plays.',
  ]),
  Object.freeze([
    'PageNarrator hardware probe second page.',
    'The next page adds fresh text to verify continuation through the document.',
    'Every spoken chunk should finish once, with the following chunk prepared ahead of playback.',
    'Selecting a different voice should preserve the text, position, and reading controls.',
  ]),
]);

export const LONG_ARTICLE = Object.freeze({
  title: 'Maintaining a Community Library Through Lean Years',
  sections: Object.freeze([
    Object.freeze({
      heading: 'An unexpected budget gap',
      paragraphs: Object.freeze([
        'In March 2019 the Riverside Community Library learned that its annual grant would fall from $48,500 to $31,250, a reduction of roughly 35.6 percent that arrived only six weeks before the fiscal year began.',
        'Dr. Alicia Moreno, who had directed the library since 2011, called an evening meeting so that volunteers, staff and patrons could hear the numbers directly rather than through rumors at the circulation desk.',
      ]),
    }),
    Object.freeze({
      heading: 'Counting what mattered',
      paragraphs: Object.freeze([
        'The first task was simple counting: the team recorded 1,742 active cards, 312 weekly visitors on average, 58 homework-club regulars, and a reading room that stayed full on Saturdays from 10 a.m. until roughly 2 p.m.',
        'Because the library kept careful paper logs, the volunteers could compare those figures with 2004, 2009 and 2014, which showed that weekday visits had dropped while weekend and after-school visits had nearly doubled over the same period.',
      ]),
    }),
    Object.freeze({
      heading: 'A schedule built around people',
      paragraphs: Object.freeze([
        'Instead of cutting hours evenly across the week, the committee proposed a schedule that closed two quiet weekday mornings, kept the evening study hall open until 8 p.m., and moved the toddler story time from Tuesday to Saturday at 11 a.m.',
        'Several longtime patrons worried that the change would hurt retirees who preferred quiet mornings, so the plan added a monthly coffee hour, a large-print exchange shelf, and a telephone reminder list that volunteers would call every Thursday afternoon.',
      ]),
    }),
    Object.freeze({
      heading: 'Repairs without contractors',
      paragraphs: Object.freeze([
        'The building needed new shelving brackets, two replacement windows and a working ramp handrail, and the lowest contractor estimate for all three items was $14,980, which was far beyond what the reduced budget could absorb that year.',
        'A retired carpenter, Mr. Okafor, offered to supervise weekend work parties, and over nine Saturdays about 40 volunteers installed 126 brackets, sealed the windows temporarily, and replaced the handrail with materials donated by a local hardware store.',
      ]),
    }),
    Object.freeze({
      heading: 'Lending beyond books',
      paragraphs: Object.freeze([
        'One of the most popular experiments was a lending shelf for tools and household items, including a pressure washer, two sewing machines, a soil tester, a tile cutter, and a set of folding tables that families borrowed for birthday parties and community events.',
        'Each item carried a laminated card with safety notes, a short list of tips written by previous borrowers, and the date of its last inspection, which reduced damage and encouraged people to return things on time.',
      ]),
    }),
    Object.freeze({
      heading: 'What the numbers showed a year later',
      paragraphs: Object.freeze([
        'By March 2020 active cards had risen to 1,968, Saturday attendance averaged 412 visitors, and the homework club had grown to 77 students, even though the library was open 6 fewer hours each week than before the grant reduction.',
        'The final report noted that the improvements came from matching hours to real demand, inviting patrons to share the work, and treating the library as a place where neighbors solved practical problems together rather than only a building that stored books.',
      ]),
    }),
  ]),
});

export const COMPLEX_ARTICLE = Object.freeze({
  title: 'How Tide Pools Recover After a Storm',
  paragraphs: Object.freeze([
    'When a winter storm rolls across a rocky shore, it rearranges boulders, scours away algae, and leaves tide pools that look almost empty the following morning.',
    'Researchers who return to the same pools week after week find that recovery follows a recognizable sequence, beginning with fast-growing green algae and small grazing snails.',
    'Within a few months, barnacles and mussels settle on newly exposed rock, and their shells create shelter for crabs, worms and young fish that could not survive in the open.',
    'Pools that keep a few large boulders in place usually recover faster, because those stable surfaces protect older communities that can reseed the surrounding rock.',
    'The slowest recovery appears where storms remove nearly every attached organism, leaving bare stone that must be colonized from neighboring pools or from larvae carried by the tide.',
  ]),
  figureCaption: 'Figure 1. A recovering tide pool three months after a storm.',
  tableCaption: 'Table 1. Typical colonizers by month after a storm.',
  // Page furniture that must not be narrated as article content.
  forbidden: Object.freeze([
    'Accept all cookies',
    'Related articles',
    'Subscribe to our newsletter',
    'Copyright 2026 Coastal Notes',
    'Home News Science About',
  ]),
});

export function longArticleReferenceText() {
  return [
    LONG_ARTICLE.title,
    ...LONG_ARTICLE.sections.flatMap((section) => [section.heading, ...section.paragraphs]),
  ].join('\n');
}

export function complexArticleCheckpoints() {
  return [COMPLEX_ARTICLE.title, ...COMPLEX_ARTICLE.paragraphs.map((paragraph) => paragraph.split(',')[0])];
}

export function renderLongArticleHtml() {
  const sections = LONG_ARTICLE.sections.map((section) => `
        <h2>${section.heading}</h2>
${section.paragraphs.map((paragraph) => `        <p>${paragraph}</p>`).join('\n')}`).join('\n');
  return `<!doctype html>
<html lang="en">
  <head><meta charset="utf-8"><title>${LONG_ARTICLE.title}</title></head>
  <body>
    <main>
      <article>
        <h1>${LONG_ARTICLE.title}</h1>
${sections}
      </article>
    </main>
  </body>
</html>`;
}

export function renderComplexArticleHtml() {
  const [first, second, third, fourth, fifth] = COMPLEX_ARTICLE.paragraphs;
  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8">
    <title>${COMPLEX_ARTICLE.title} | Coastal Notes</title>
    <style>
      body { margin: 0; font-family: Georgia, serif; }
      .site-nav a { margin-right: 12px; }
      .layout { display: grid; grid-template-columns: 1fr 260px; gap: 24px; padding: 24px; }
      .columns { column-count: 2; column-gap: 32px; }
      .cookie { position: fixed; bottom: 0; left: 0; right: 0; background: #222; color: #fff; padding: 12px; }
    </style>
  </head>
  <body>
    <header class="site-header">
      <nav class="site-nav" aria-label="Site"><a href="#">Home</a> <a href="#">News</a> <a href="#">Science</a> <a href="#">About</a></nav>
    </header>
    <div class="layout">
      <main>
        <article>
          <h1>${COMPLEX_ARTICLE.title}</h1>
          <p class="byline">By the field notes team</p>
          <div class="columns">
            <p>${first}</p>
            <p>${second}</p>
            <figure>
              <svg width="240" height="80" role="img" aria-label="Tide pool sketch"><rect width="240" height="80" fill="#9cc"/></svg>
              <figcaption>${COMPLEX_ARTICLE.figureCaption}</figcaption>
            </figure>
            <p>${third}</p>
            <p>${fourth}</p>
          </div>
          <table>
            <caption>${COMPLEX_ARTICLE.tableCaption}</caption>
            <thead><tr><th>Month</th><th>Colonizers</th></tr></thead>
            <tbody>
              <tr><td>First</td><td>Green algae and grazing snails</td></tr>
              <tr><td>Third</td><td>Barnacles and mussels</td></tr>
            </tbody>
          </table>
          <p>${fifth}</p>
        </article>
      </main>
      <aside aria-label="Related">
        <h2>Related articles</h2>
        <ul><li><a href="#">Kelp forests in warm years</a></li><li><a href="#">Counting sea stars</a></li></ul>
        <form><p>Subscribe to our newsletter</p><input type="email" aria-label="Email"><button type="button">Sign up</button></form>
      </aside>
    </div>
    <footer><p>Copyright 2026 Coastal Notes. All rights reserved.</p></footer>
    <div class="cookie" role="dialog" aria-label="Cookie consent"><p>We use cookies to improve this site.</p><button type="button">Accept all cookies</button></div>
  </body>
</html>`;
}

// Continuous-reading soak document: authored sentences rotated into numbered
// parts of about 140 words; 72 parts is a little over an hour at 1x.
const SOAK_SENTENCES = Object.freeze([
  'The river town kept a written record of every flood, harvest and festival for more than two hundred years.',
  'Each volume of the record was copied by hand, checked by a second reader, and stored in a dry room above the market hall.',
  'When the bridge was rebuilt, engineers used the old notes to estimate how high the water had risen in each decade.',
  'Teachers asked students to compare the handwriting in different volumes and to guess how many people had kept the record.',
  'A retired surveyor discovered that two pages had been bound in the wrong order, which explained a puzzling gap in the timeline.',
  'The town council later scanned every page, but it kept the paper volumes because readers trusted the original ink.',
  'Visitors often asked to see the entry for the great storm, when the market hall itself had flooded to the second step.',
  'Volunteers prepared short summaries for each decade so that new readers could find their way through the long record.',
]);

export function renderSoakArticleHtml(parts = 72) {
  const sections = Array.from({ length: parts }, (_, index) => {
    const sentences = Array.from({ length: 6 }, (_unused, offset) => SOAK_SENTENCES[(index + offset) % SOAK_SENTENCES.length]);
    return `        <h2>Part ${index + 1}</h2>\n        <p>${sentences.join(' ')}</p>`;
  }).join('\n');
  return `<!doctype html>
<html lang="en">
  <head><meta charset="utf-8"><title>The River Town Record</title></head>
  <body>
    <main>
      <article>
        <h1>The River Town Record</h1>
${sections}
      </article>
    </main>
  </body>
</html>`;
}

export const SCANNED_PDF_SENTENCES = Object.freeze([
  'Requirements engineering begins with clear goals.',
  'Stakeholders describe the system they need.',
]);
