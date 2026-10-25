// Copyright 2026 Felix Olsson. SPDX-License-Identifier: GPL-3.0-or-later
// Original transcription of normative SID/encoding facts from Adobe TN5176, Appendices A/B.
// https://adobe-type-tools.github.io/font-tech-notes/pdfs/5176.CFF.pdf
// These are CFF ExpertEncoding mappings, distinct from PDF MacExpertEncoding.
export const extendedCffStandardStrings = [
  ...'exclamsmall Hungarumlautsmall dollaroldstyle dollarsuperior ampersandsmall Acutesmall parenleftsuperior parenrightsuperior twodotenleader onedotenleader zerooldstyle oneoldstyle'.split(' '),
  ...'twooldstyle threeoldstyle fouroldstyle fiveoldstyle sixoldstyle sevenoldstyle eightoldstyle nineoldstyle commasuperior threequartersemdash periodsuperior questionsmall'.split(' '),
  ...'asuperior bsuperior centsuperior dsuperior esuperior isuperior lsuperior msuperior nsuperior osuperior rsuperior ssuperior'.split(' '),
  ...'tsuperior ff ffi ffl parenleftinferior parenrightinferior Circumflexsmall hyphensuperior Gravesmall Asmall Bsmall Csmall'.split(' '),
  ...'Dsmall Esmall Fsmall Gsmall Hsmall Ismall Jsmall Ksmall Lsmall Msmall Nsmall Osmall'.split(' '),
  ...'Psmall Qsmall Rsmall Ssmall Tsmall Usmall Vsmall Wsmall Xsmall Ysmall Zsmall colonmonetary'.split(' '),
  ...'onefitted rupiah Tildesmall exclamdownsmall centoldstyle Lslashsmall Scaronsmall Zcaronsmall Dieresissmall Brevesmall Caronsmall Dotaccentsmall'.split(' '),
  ...'Macronsmall figuredash hypheninferior Ogoneksmall Ringsmall Cedillasmall questiondownsmall oneeighth threeeighths fiveeighths seveneighths onethird'.split(' '),
  ...'twothirds zerosuperior foursuperior fivesuperior sixsuperior sevensuperior eightsuperior ninesuperior zeroinferior oneinferior twoinferior threeinferior'.split(' '),
  ...'fourinferior fiveinferior sixinferior seveninferior eightinferior nineinferior centinferior dollarinferior periodinferior commainferior Agravesmall Aacutesmall'.split(' '),
  ...'Acircumflexsmall Atildesmall Adieresissmall Aringsmall AEsmall Ccedillasmall Egravesmall Eacutesmall Ecircumflexsmall Edieresissmall Igravesmall Iacutesmall'.split(' '),
  ...'Icircumflexsmall Idieresissmall Ethsmall Ntildesmall Ogravesmall Oacutesmall Ocircumflexsmall Otildesmall Odieresissmall OEsmall Oslashsmall Ugravesmall'.split(' '),
  ...'Uacutesmall Ucircumflexsmall Udieresissmall Yacutesmall Thornsmall Ydieresissmall 001.000 001.001 001.002 001.003 Black Bold'.split(' '),
  ...'Book Light Medium Regular Roman Semibold'.split(' '),
];

// Index is an 8-bit character code; zero means unencoded (.notdef).
export const cffExpertEncodingSids = [
  0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0,
  0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0,
  1, 229, 230, 0, 231, 232, 233, 234, 235, 236, 237, 238, 13, 14, 15, 99,
  239, 240, 241, 242, 243, 244, 245, 246, 247, 248, 27, 28, 249, 250, 251, 252,
  0, 253, 254, 255, 256, 257, 0, 0, 0, 258, 0, 0, 259, 260, 261, 262,
  0, 0, 263, 264, 265, 0, 266, 109, 110, 267, 268, 269, 0, 270, 271, 272,
  273, 274, 275, 276, 277, 278, 279, 280, 281, 282, 283, 284, 285, 286, 287, 288,
  289, 290, 291, 292, 293, 294, 295, 296, 297, 298, 299, 300, 301, 302, 303, 0,
  0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0,
  0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0,
  0, 304, 305, 306, 0, 0, 307, 308, 309, 310, 311, 0, 312, 0, 0, 313,
  0, 0, 314, 315, 0, 0, 316, 317, 318, 0, 0, 0, 158, 155, 163, 319,
  320, 321, 322, 323, 324, 325, 0, 0, 326, 150, 164, 169, 327, 328, 329, 330,
  331, 332, 333, 334, 335, 336, 337, 338, 339, 340, 341, 342, 343, 344, 345, 346,
  347, 348, 349, 350, 351, 352, 353, 354, 355, 356, 357, 358, 359, 360, 361, 362,
  363, 364, 365, 366, 367, 368, 369, 370, 371, 372, 373, 374, 375, 376, 377, 378,
];
