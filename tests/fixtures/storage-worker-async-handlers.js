/**
 * Test-only registry with an `async` handler: the storage worker must refuse
 * it when the registry loads (start_failed), not at call time.
 */
export default {
  commands: {
    async asyncHandler() {
      return { never: true };
    },
  },
};
