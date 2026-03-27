export { scoreDeck } from './scoring.js';
export { analyzeDeck } from './analysis.js';
export { suggestSwaps } from './suggestions.js';
export { buildMatchupMatrix, getCounterDecks, getBestDeckVsField } from './matchup-matrix.js';
export { solveNash, compareToActualMeta } from './nash-solver.js';
export { detectBehavioralBias, getTopEVPicks } from './behavioral-analysis.js';
export { scoreEvolutionaryStability, simulateMetaShift } from './evolutionary-stability.js';
export { computeShapley, suggestShapleySwaps } from './shapley-engine.js';
export { analyzeFormatFit, compareFormatFitAcrossMeta } from './mechanism-analyzer.js';
export { analyzeFullMeta } from './intelligence-api.js';
export { classifyCardRole, getEvolutionSpeedModifier, calculateTTK,
         ARCHETYPES, simulateDeckVariants,
         buildOptimalDeck, buildMetaOptimalDecks } from './deck-builder.js';
export { TRAINER_CLASSES, getTrainerClass, getTrainerEffect,
         getTrainerForType, isTypeCompatible,
         isSupporter, isItem, isTool, isStadium } from './trainer-data.js';
