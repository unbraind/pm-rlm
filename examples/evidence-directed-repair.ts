import { repairRlm, resumeRepairRlm } from 'pm-rlm';

// Names must match every component declared by the original evidence run, in order.
const receipt = await repairRlm({
  source: 'original-run-id',
  budget_tokens: 50000,
  parts: [
    { name: 'diagnosis', question: 'What does the source establish?', depends_on: [], sources: ['source-item-id'] },
    { name: 'remedy', question: 'Which remedy follows from the diagnosis?', depends_on: ['diagnosis'], sources: ['source-item-id'] },
  ],
}, { workspace: '.agents/pm', author: 'repair-agent' });

if (receipt.status !== 'skipped') {
  console.log(receipt.components, receipt.budget, receipt.gaps);
  // Recovery uses the recorded fresh budget and revalidates current revisions.
  console.log(await resumeRepairRlm(receipt.run, { workspace: '.agents/pm' }));
}
