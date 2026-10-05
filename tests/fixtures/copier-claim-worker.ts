import { Journal } from '../../packages/execution/src/journal.ts';

const journal = new Journal(process.argv[2]!);
process.send?.('READY');
process.once('message', (message) => {
  if (message !== 'CLAIM') process.exit(1);
  try {
    const result = journal.copier.claimFollowerAttempt(
      {
        eventId: process.argv[3]!,
        followerAccountId: '02',
        quantity: '1',
        leverage: '10',
      },
      process.argv[4]!,
      Number(process.argv[5]),
    );
    journal.close();
    process.send?.({
      fresh: result.fresh,
      attemptId: result.attempt.attemptId,
    });
  } catch {
    journal.close();
    process.send?.('FAILED');
  } finally {
    process.disconnect();
  }
});
