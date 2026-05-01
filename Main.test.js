const { shuffle } = require('./Main');

describe('shuffle', () => {
    test('should return an array of the same length', () => {
        const input = [1, 2, 3, 4, 5];
        const result = shuffle([...input]);
        expect(result).toHaveLength(input.length);
    });

    test('should contain all original elements', () => {
        const input = [1, 2, 3, 4, 5];
        const result = shuffle([...input]);
        expect(result.sort()).toEqual([...input].sort());
    });

    test('should handle empty arrays', () => {
        const input = [];
        const result = shuffle([...input]);
        expect(result).toEqual([]);
    });

    test('should handle single-element arrays', () => {
        const input = [1];
        const result = shuffle([...input]);
        expect(result).toEqual([1]);
    });

    test('should actually shuffle the array (probabilistic)', () => {
        const input = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10];
        const result = shuffle([...input]);
        // There is a very small chance (1/10!) that it remains the same
        expect(result).not.toEqual(input);
    });

    test('should shuffle deterministically with mocked Math.random', () => {
        const input = [1, 2, 3];
        const spy = jest.spyOn(Math, 'random');

        spy.mockReturnValueOnce(0.5) // i=2, j=Math.floor(0.5 * 3) = 1. Swap array[2] and array[1] -> [1, 3, 2]
           .mockReturnValueOnce(0.5); // i=1, j=Math.floor(0.5 * 2) = 1. Swap array[1] and array[1] -> [1, 3, 2]

        const result = shuffle([...input]);

        expect(result).toEqual([1, 3, 2]);

        spy.mockRestore();
    });
});
