import { auditRepository, verifyArtifact } from './security-policy.ts';

auditRepository(process.cwd());
if (process.argv[2]) verifyArtifact(process.argv[2]);
console.log(
  'Security containment checks passed. Live execution remains unavailable.',
);
