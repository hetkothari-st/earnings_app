import { describe, expect, test } from 'vitest';
import { beatMiss, surprisePct } from '../../src/domain/surprise.js';

describe('surprisePct', () => {
  test('positive and negative estimates use |estimate|', () => {
    expect(surprisePct(1.71, 1.66)).toBe(3.0);
    expect(surprisePct(-0.76, -0.71)).toBe(-7.0);
    expect(surprisePct(5.75, 5.94)).toBe(-3.2);
  });
  test('zero or missing estimate -> null', () => {
    expect(surprisePct(1, 0)).toBeNull();
    expect(surprisePct(1, null)).toBeNull();
    expect(surprisePct(null, 1)).toBeNull();
  });
});

describe('beatMiss', () => {
  test('classifies', () => {
    expect(beatMiss(1.71, 1.66)).toBe('beat');
    expect(beatMiss(1.6, 1.66)).toBe('miss');
    expect(beatMiss(1.66, 1.66)).toBe('inline');
    expect(beatMiss(null, 1.66)).toBeNull();
    expect(beatMiss(1.66, null)).toBeNull();
  });
});
