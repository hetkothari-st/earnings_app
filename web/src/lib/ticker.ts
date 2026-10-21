/** Live prices are keyed one way per security (BRK/B, BRK.B and BRK-B all become BRK-B); same rule as the server. */
export const priceKey = (symbol: string): string => symbol.trim().toUpperCase().replace(/[./]/g, '-');
