/** FAQ answers reuse the docs page text; never maintain a second set of guides. */
export const FAQ_DOCS = {
  q1: { topic: 'intro', keys: ['docs.introLead'] },
  q2: { topic: 'login', keys: ['docs.loginLead', 'docs.loginPermissionsBody'] },
  q3: { topic: 'proof-login', keys: ['proofs.loginIntro', 'proofs.loginPrivacy'] },
  q4: { topic: 'proof-login', keys: ['proofs.loginPrivacy'] },
  q5: { topic: 'topics', keys: ['proofs.loginIntro', 'proofs.workspaceIntro', 'proofs.kycIntro', 'proofs.countryIntro'] },
  q6: { topic: 'chat', keys: ['docs.chatLead', 'docs.cliPrivacyBody', 'docs.cliPrivacyTiers'] },
  q7: { topic: 'topics', keys: ['proofs.workflowIntro', 'proofs.workflowConsent', 'proofs.workflowApp', 'proofs.workflowWait', 'proofs.workflowSeparate', 'proofs.workflowAi', 'proofs.workflowResume'] },
} as const;
