/*
 * How many syllables an English word has, near enough to time it by: the
 * groups of vowels it spells, less a silent final e, -es, or -ed, plus the
 * vowel pairs that are said apart ("go-ing", "li-on"). Wrong now and then
 * ("every" may be two or three), which only nudges where a word lands.
 */

/** The letters a–z of `word`, lowercase, accents taken off. */
const plainLetters = (word: string): string =>
  word
    .normalize('NFD')
    .replace(/\p{M}/gu, '')
    .toLowerCase()
    .replace(/[^a-z]/g, '')

/** Vowel pairs said as two syllables: "being", "flying", "lion", "piano". */
const SPLIT_PAIRS = /[aeiouy]ings?$|[^aeiou]i[ao]/g

/** Where the pair is one sound after all: "nation", "special", "region". */
const ONE_SOUND = /[tscxg]i[ao]/g

export const syllables = (word: string): number => {
  const digits = word.replace(/[^0-9]/g, '')
  const letters = plainLetters(word)
  if (letters.length === 0) {
    // "2", "99": a syllable or so a digit.
    return Math.max(1, digits.length)
  }
  if (letters.length <= 3) return 1
  const groups = letters.match(/[aeiouy]+/g)?.length ?? 1
  let count = groups
  // A silent final e: "love", "fire", "make" (but "people", "little",
  // "free", "be" keep it).
  if (/[^aeiouy]e$/.test(letters) && !/[^aeiouy]le$/.test(letters)) count--
  // -es and -ed are silent unless they follow the sounds that need them:
  // "makes" and "walked", but "boxes" and "wanted".
  else if (/[^aeiouysxzgc]es$/.test(letters) && !/(?:ch|sh)es$/.test(letters))
    count--
  else if (/[^aeiouytd]ed$/.test(letters)) count--
  const split = letters.match(SPLIT_PAIRS)?.length ?? 0
  const joined = letters.match(ONE_SOUND)?.length ?? 0
  count += Math.max(0, split - joined)
  return Math.max(1, count)
}
