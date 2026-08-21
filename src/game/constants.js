export const STAGES = [
  { scale: 4.2, vignette: 9, label: "PINHOLE", points: 1000 },
  { scale: 3.2, vignette: 16, label: "SLIVER", points: 800 },
  { scale: 2.3, vignette: 26, label: "NARROW", points: 600 },
  { scale: 1.7, vignette: 42, label: "WIDENING", points: 400 },
  { scale: 1.25, vignette: 68, label: "OPEN", points: 250 },
  { scale: 1, vignette: 150, label: "FULL", points: 100 },
];

// Direct upload.wikimedia.org thumbnails: single hop, sized for fast host-side
// loading, and served with Access-Control-Allow-Origin so the host's canvas
// can crop them without tainting.
const WIKIMEDIA = "https://upload.wikimedia.org/wikipedia/commons/thumb";

export const STARTER_ROUNDS = [
  { id: "s1", url: `${WIKIMEDIA}/a/a8/Tour_Eiffel_Wikimedia_Commons.jpg/1280px-Tour_Eiffel_Wikimedia_Commons.jpg`, answer: "Eiffel Tower", hint: "Parisian landmark" },
  { id: "s2", url: `${WIKIMEDIA}/9/9e/Giraffe_Mikumi_National_Park.jpg/1280px-Giraffe_Mikumi_National_Park.jpg`, answer: "Giraffe", hint: "Tallest land mammal" },
  { id: "s3", url: `${WIKIMEDIA}/8/85/Yellow_Rubber_Duck.jpg/1280px-Yellow_Rubber_Duck.jpg`, answer: "Rubber Duck", hint: "Bath time icon" },
  { id: "s4", url: `${WIKIMEDIA}/0/0c/GoldenGateBridge-001.jpg/1280px-GoldenGateBridge-001.jpg`, answer: "Golden Gate Bridge", hint: "San Francisco crossing" },
  { id: "s5", url: `${WIKIMEDIA}/6/6a/Mona_Lisa.jpg/1280px-Mona_Lisa.jpg`, answer: "Mona Lisa", hint: "Mysterious smile" },
  { id: "s6", url: `${WIKIMEDIA}/0/0f/Strawberry.jpg/1280px-Strawberry.jpg`, answer: "Strawberry", hint: "Seeded red fruit" },
  { id: "s7", url: `${WIKIMEDIA}/e/e1/FullMoon2010.jpg/1280px-FullMoon2010.jpg`, answer: "Moon", hint: "Earth's natural satellite" },
  { id: "s8", url: `${WIKIMEDIA}/a/a0/Great_Pyramid_of_Giza.jpg/1280px-Great_Pyramid_of_Giza.jpg`, answer: "Pyramid of Giza", hint: "Ancient wonder in Egypt" },
  { id: "s9", url: `${WIKIMEDIA}/7/72/Basketball_Clipart.svg/1280px-Basketball_Clipart.svg.png`, answer: "Basketball", hint: "Orange pebbled sphere" },
  { id: "s10", url: `${WIKIMEDIA}/3/3e/Tennis_Racket_and_Balls.jpg/1280px-Tennis_Racket_and_Balls.jpg`, answer: "Tennis Ball", hint: "Fuzzy neon sphere" },
];

export const MAX_NAME = 20;
export const MAX_GUESS = 60;
export const FEED_LENGTH = 10;

export function stagePoints(stageIndex, hintUsed) {
  const base = STAGES[stageIndex].points;
  return hintUsed ? Math.round(base / 2) : base;
}

export function awardPoints(stageIndex, rank, hintUsed) {
  const base = stagePoints(stageIndex, hintUsed);
  if (rank === 0) return base;
  if (rank === 1) return Math.round(base / 2);
  return Math.max(hintUsed ? 25 : 50, Math.round(base / 4));
}
