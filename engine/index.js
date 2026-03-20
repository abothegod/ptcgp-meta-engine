export { scoreDeck } from './scoring.js';
export { analyzeDeck } from './analysis.js';
export { suggestSwaps } from './suggestions.js';
export { buildMatchupMatrix, getCounterDecks, getBestDeckVsField } from './matchup-matrix.js';
export { solveNash, compareToActualMeta } from './nash-solver.js';
export { detectBehavioralBias, getTopEVPicks } from './behavioral-analysis.js';
export { scoreEvolutionaryStability, simulateMetaShift } from './evolutionary-stability.js';
export { computeShapley, suggestShapleySwaps } from './shapley-engine.js';
