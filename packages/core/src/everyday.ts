import words from "../data/everyday-words.json";

/**
 * Everyday words of shop talk in Bangla and Banglish (data/everyday-words.json, D162): the near-word clean-up never
 * takes them for a misheard shop name ("সব কাস্টমার" is not the self motor, "এই মাসে" not a Hiace).
 */
export const EVERYDAY_WORDS: readonly string[] = [...words.bangla, ...words.banglish];
