const sentences = [
  'The morning sun warmed the garden as we opened the door and stepped outside.',
  'A small bird landed beside the garden and sang softly in the fresh air.',
  'We followed the quiet path through the garden and stopped beside the old stone wall.',
  'Behind the garden, a narrow stream carried fallen leaves toward a wooden bridge.',
  'We crossed the bridge near the garden and watched the water flow around the stones.',
  'On the far bank beside the garden, a family rested beneath a tall green tree.',
  'Their children waved from the garden and pointed to a red kite floating in the sky.',
  'We walked back through the garden and reached our door just before the rain began.',
  'Inside the house beside the garden, we put our muddy shoes beside the mat.',
  'The rain tapped on the windows while we watched the path leading to the garden.',
  'I chose two blue cups and carried them to the little table overlooking the garden.',
  'Through the glass, we could see the garden flowers bending under the falling rain.',
  'A neighbour hurried past the garden with a basket full of fresh apples.',
  'We invited her inside and found another cup while she looked out at the garden.',
  'She told us about the musicians playing near the garden earlier that morning.',
  'After a while, the rain stopped and sunlight appeared on the path to the garden.',
  'We opened the back door and listened to the drops falling in the garden.',
  'The little bird returned to the garden and shook the water from its feathers.',
  'Our neighbour picked up her basket and waved goodbye as she walked past the garden.',
  'We stayed at the table and enjoyed the quiet view of the garden before our day began.',
];

export const longNarrationParagraphs = ['garden', 'orchard', 'meadow', 'courtyard', 'village', 'clearing', 'hillside', 'pasture', 'woodland']
  .flatMap(place => sentences.map(sentence => sentence.replace('garden', place)));
