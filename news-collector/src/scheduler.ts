/** Boot and scheduled triggers must hold the same lock until collection settles. */
export function createNonOverlappingRunner(
  collect: () => Promise<void>,
  onSkip: () => void = () => undefined,
): () => Promise<void> {
  let active: Promise<void> | null = null;
  return () => {
    if (active) {
      onSkip();
      return active;
    }
    // Queue the call so even a synchronous throw releases the shared lock.
    active = Promise.resolve().then(collect).finally(() => { active = null; });
    return active;
  };
}
