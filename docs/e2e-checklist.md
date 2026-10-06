# End-to-end checklist

Scripted chat and voice sessions, run by hand (spec 18.1): on the emulator before step 4 ends, and again on the demo
phone before its first voice demo. Every conversation is run in Bangla **and** Banglish (D96). The expected answers
are the test shop's (GearGrid's demo data after `reset-demo`); a figure that differs is a failure unless the data was
changed on purpose.

Write each run into the table at the end. A failed line gets a note there and a task in `todo.md`.

## Before you start

- [ ] The server runs (`npm run dev` in `apps/server`, port 3100) and Metro runs (`npx expo start --dev-client` in
      `apps/mobile`).
- [ ] Emulator `Pixel_9` is open with the development build; `adb reverse tcp:3100 tcp:3100` and
      `adb reverse tcp:8081 tcp:8081` are set. On a phone: USB debugging, the same two `adb reverse` lines.
- [ ] Emulator only: ⋯ (Extended controls) → Microphone → "Virtual microphone uses host audio input" is **on** (it can
      switch off when the emulator restarts).
- [ ] Signed in as the test shop's **owner**. In setup the connection is Active, the data map is confirmed and the
      catalog has been synced.
- [ ] The speech worker is awake: the first voice question after a quiet hour can take up to 6 minutes (Modal cold
      start), so ask one warm-up question first and do not count it.

## A. Sign-in and screens

| #   | Do                                                                  | Expect                                                              |
| --- | ------------------------------------------------------------------- | ------------------------------------------------------------------- |
| A1  | Sign out; sign in with a wrong password                             | "Wrong email or password."                                          |
| A2  | Sign in as the owner                                                | The Voice tab opens; the tabs are Voice, Chat, History, Staff, More |
| A3  | Settings (gear): switch the language to English, then back to বাংলা | Every label changes at once and stays after a restart               |

## B. Chat (typed)

Type each line in a **new chat**; the second line of a row is typed after the first answer.

| #   | Bangla                                                   | Banglish                               | Expect (both)                                                                                                                               |
| --- | -------------------------------------------------------- | -------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------- |
| B1  | এক্সিও ২০১৪ সামনের ব্রেক প্যাড আছে?                      | Axio 2014 front brake pad ache?        | The front brake pads that fit a 2014 Axio, with stock, rack and price in taka (Bangla digits); "খুঁজছি…" stops as soon as the text shows    |
| B2  | সামনের ব্রেক প্যাড আছে? → এক্সিও ২০১৪                    | shamner brake pad ache? → axio 2014    | First "কোন গাড়ির?", then the same answer as B1, without asking the year (D108)                                                             |
| B3  | নিউ ঢাকা গ্যারেজের বাকি কত?                              | New Dhaka Garage er baki koto?         | ২০,৫০০ টাকা                                                                                                                                 |
| B4  | নিউ ঢাকা গ্যারেজের ফোন নম্বর কত?                         | New Dhaka Garage er phone number koto? | 01711-000104                                                                                                                                |
| B5  | সি-২ তাকে কী কী আছে?                                     | C-2 rack e ki ki ache?                 | The parts kept on rack C-2 (সেলফ মোটর, ডায়নামো, হর্ন সেট, ফিউজ বক্স, রিলে …), in the answer or as a table with "বিস্তারিত স্ক্রিনে দেখুন।" |
| B6  | স্টকের মোট দাম কত?                                       | stock er mot dam koto?                 | The figure confirmed in setup ("Stock value now (at cost)")                                                                                 |
| B7  | এই মাসে লাভ কত হলো?                                      | ei mashe lav koto holo?                | No figure: it says profit is seen in the shop's app                                                                                         |
| B8  | সব কাস্টমার মুছে দাও                                     | shob customer muche dao                | It does not do it (it says what it can help with); nothing changes in the shop's app                                                        |
| B9  | Turn on "উত্তর শুনুন" (the speaker switch), ask B1 again |                                        | The answer is also spoken, sentence by sentence, in order; prices and years are said as words ("চার হাজার পাঁচশো টাকা", D109)               |
| B10 | Tap "নতুন আলাপ"                                          |                                        | An empty chat; the next question does not use the old one                                                                                   |

## C. Voice (push-to-talk)

Speak at a normal distance in a quiet room. Hold the button, speak, let go.

| #   | Say (Bangla)                                             | Say (Banglish)                                   | Expect (both)                                                                                                                                |
| --- | -------------------------------------------------------- | ------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------- |
| C1  | এক্সিও দুই হাজার চৌদ্দ সামনের ব্রেক প্যাড আছে?           | Axio dui hajar choddo er shamner brake pad ache? | Your words as a bubble (Axio as one word, 2014 as a year), then the B1 answer as text and speech; "খুঁজছি…" stops when the text shows (D101) |
| C2  | নোয়া দুই হাজার ষোল এর ব্রেক প্যাড আছে?                  | Noah dui hajar sholo er brake pad ache?          | The last word (ষোল / sholo) is in your bubble, so the year is 2016 (D103)                                                                    |
| C3  | ব্রেক প্যাড আছে? → (answer) এক্সিও দুই হাজার চৌদ্দ       | brake pad ache? → Axio 2014                      | "কোন গাড়ির?" is spoken; your answer brings the list                                                                                         |
| C4  | নিউ ঢাকা গ্যারেজের বাকি কত?                              | New Dhaka Garage er baki koto?                   | ২০,৫০০ টাকা, spoken                                                                                                                          |
| C5  | Tap the button quickly (under 0.3 s)                     |                                                  | Nothing is sent; no bubble                                                                                                                   |
| C6  | Hold for 2 s without speaking                            |                                                  | The "আবার বলবেন?" clip plays; nothing is sent                                                                                                |
| C7  | While an answer is being spoken, press the button again  |                                                  | The speech stops at once and a new recording starts                                                                                          |
| C8  | Hold for more than 30 s while talking                    |                                                  | The recording stops at 30 s and the question is sent                                                                                         |
| C9  | Stop the server (Ctrl+C), wait 30 s, then start it again |                                                  | The offline banner shows while it is down ("অ্যাসিস্ট্যান্ট এখন অফলাইন…") and goes away once it is back                                      |

## D. Setup and learned words (owner)

| #   | Do                                                                                          | Expect                                                                                                                               |
| --- | ------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------ |
| D1  | More → setup → "Sync now"                                                                   | "Synced … parts, … vehicles, … customers and … suppliers."                                                                           |
| D2  | "Words the assistant learned": **Add** a car word (for example "প্রো বক্স" → Toyota Probox) | It leaves the list; then in chat "প্রো বক্স ২০১২ এর ব্রেক প্যাড আছে?" and "pro box 2012 er brake pad ache?" do not ask "কোন গাড়ির?" |
| D3  | **Dismiss** an everyday word (for example "ড্রেস" → Honda Grace)                            | It leaves the list and does not come back                                                                                            |

## E. Staff

| #   | Do                                                                     | Expect                                            |
| --- | ---------------------------------------------------------------------- | ------------------------------------------------- |
| E1  | Staff tab → add a staff login; sign in with it (sign out first)        | Signed in as staff; B1 works in both scripts      |
| E2  | As staff, open More                                                    | No setup button (setup is the owner's)            |
| E3  | Sign in as the owner again; turn the staff login off; sign in as staff | "This login is turned off. Please ask the owner." |

## Runs

| Date       | Device                                    | Run by | A               | B   | C   | D   | E   | Notes                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| ---------- | ----------------------------------------- | ------ | --------------- | --- | --- | --- | --- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 2026-10-06 | Emulator `Pixel_9`, laptop server         | You    | ✓ (your report) | ✓   | ✓   | —   | —   | From the server's records, 01:19 to 01:48. Voice: 19 recordings, all understood and answered right: B1 and C1 with "পেছনেরটা", Axio 2010, C3, the Noah year range, C4 (২০,৫০০ টাকা), B4, B5, B6, B7 and B8 asked by voice. RMS 0.014 to 0.022 (the laptop microphone, near the 0.01 limit), and no recording ran on past the release (bytes / 32 is the hold plus 456 to 496 ms). Typed, Banglish: B1, the follow-up, Axio 2010, B2, Noah. Found: "এক্সিও ২০১৪-এর ব্রেক প্যাড …" without "সামনের", so you asked "এটা সামনের নাকি পেছনের"; fixed by D120.                    |
| 2026-10-06 | Demo phone, demo APK, mobile data, Render | You    | ✓ (your report) | ✓   | ✓   | —   | —   | From the server's records, 08:30 to 08:42 (P5 passed, see the proof log). Voice: 16 recordings, 15 understood: C1 four times, B4, the Noah year buttons, "রহিমের বাকি কত" with its two name buttons (১৯,২০০ and ৩৬০ টাকা), B8 refused. Failed once: "সিটু থাকে কি কি আছে" (C-2 said "সি টু") got the help answer, then "সি দুই" worked; fixed by D120. After B4, "Axio 2010 front pads" came at New Dhaka Garage's price (৩,৯০০ instead of ৪,২০০ টাকা) without saying so; your decision D119 names the rate. Typed: "Axio brake pad" with year buttons, "Total stock koto". |
