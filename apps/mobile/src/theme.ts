// The app's look in one place (spec D166): clean and light, keeping DokaanBondhu's green; large text and large touch
// targets for greasy hands (architecture, non-functional requirements). The phone's own Bangla font is kept, so every
// joined letter shows right on every phone.

export const colors = {
  green: "#1f7a4d",
  greenDark: "#17603c",
  /** Green text on a light ground. */
  greenInk: "#135233",
  greenSoft: "#e3f1e9",
  /** The page behind the cards. */
  page: "#f3f5f4",
  card: "#ffffff",
  ink: "#1b1f23",
  muted: "#56616b",
  faint: "#8a949c",
  line: "#e0e5e8",
  chip: "#eef1f3",
  danger: "#b3261e",
  dangerSoft: "#fdecea",
  warnInk: "#6e4300",
  warnSoft: "#fff1d9",
  infoInk: "#1d4a80",
  infoSoft: "#e7effa",
  white: "#ffffff",
};

export const space = { xs: 4, sm: 8, md: 12, lg: 16, xl: 20, xxl: 24 };

export const radius = { sm: 10, md: 14, lg: 18, pill: 999 };

/** Font sizes: body text stays 17 or more. */
export const type = { title: 20, heading: 18, body: 17, small: 15, tiny: 13 };

/** The soft shadow under a card (elevation on Android). */
export const shadow = {
  elevation: 1,
  shadowColor: "#101828",
  shadowOpacity: 0.06,
  shadowRadius: 3,
  shadowOffset: { width: 0, height: 1 },
};
