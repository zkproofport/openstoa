/** Factual shared help contract, derived from handlers rather than prose snapshots. */
import {describe, expect, it} from 'vitest';
import {REST_OPERATIONS, getRestOperation} from '../../../sdk/src/rest/operations';
import {authorizationForRoute} from '../../../sdk/src/rest/authorizationPolicies';
const help=(id:string)=>{const op=getRestOperation(id);return `${op.description} ${op.access}`;};
const parameter=(id:string,name:string)=>getRestOperation(id).parameters.find(p=>p.name===name)!;
describe('shared operation help matches server behavior',()=>{
 it.each(['post_vote','post_bookmark','post_react','post_record'])('%s distinguishes readable public/private posts from secret membership',id=>{
  for(const fact of [/public/i,/private/i,/secret/i,/member/i])expect(help(id)).toMatch(fact);
  expect(getRestOperation(id).access).not.toMatch(/^Topic member[.;]/i);
 });
 it('topic deletion distinguishes site administrators from topic administrators',()=>{
  expect(getRestOperation('topic_delete').description).toMatch(/site|global/i);
  expect(getRestOperation('topic_delete').description).not.toMatch(/you own or administer/i);
  expect(help('topic_delete')).toMatch(/personal.*cannot/i);
 });
 it('domain badge publication uses the currently verified domain',()=>{
  for(const id of ['profile_domain_badge','profile_set_domain_badge','profile_remove_domain_badge'])expect(help(id)).toMatch(/current/i);
 });
 it('legacy approval explains the requester proof-cache prerequisite',()=>{
  for(const fact of [/requester|applicant/i,/verified|trusted/i,/already.*matching/i])expect(help('topic_approve')).toMatch(fact);
 });
 it('activity record listings describe returned posts rather than individual blockchain records',()=>{
  for(const id of ['activity_recorded','activity_recorded_on_mine'])expect(getRestOperation(id).description).toMatch(/posts/i);
 });
 it('mark-read identifies the message timestamp rather than the time someone opened it',()=>{
  expect(parameter('chat_mark_read','readAt').description).toMatch(/message/i);
  expect(parameter('chat_mark_read','readAt').description).toMatch(/createdAt|creation|created|server timestamp/i);
 });
 it.each([['upload_delete','urls'],['post_poll_vote','optionIds']])('%s explains array versus CLI CSV input',(id,name)=>{
  const field=parameter(id,name);expect(field.type).toBe('strings');
  expect(field.description).toMatch(/array/i);expect(field.description).toMatch(/CLI.*comma|comma.*CLI/i);
 });
 it.each(REST_OPERATIONS.filter(op=>op.parameters.some(p=>p.name==='offset')).map(op=>op.id))('%s documents paging defaults',id=>{
  expect(parameter(id,'limit').description).toMatch(/default\s*20/i);
  expect(parameter(id,'offset').description).toMatch(/default\s*0/i);
 });
 it('documents defaults for feed sorting, candidate count and request status',()=>{
  expect(parameter('feed','sort').description).toMatch(/default\s*hot/i);
  expect(parameter('dm_candidates','limit').description).toMatch(/default\s*200/i);
  expect(parameter('topic_requests','status').description).toMatch(/default\s*pending/i);
  expect(help('dm_candidates')).toMatch(/shar(?:e|ed|ing)/i);
 });
 it('every operation advertises server capabilities, including member management',()=>{
  expect(REST_OPERATIONS).toHaveLength(47);
  for(const op of REST_OPERATIONS){
   const policy=authorizationForRoute(op.path.replace(/\{([^}]+)\}/g,'[$1]'),op.method);
   expect(op.capabilities,op.id).toEqual(policy?.kind==='capability'?[...(policy.all??[]),...(policy.any??[])]:[]);
  }
  expect(getRestOperation('topic_kick').capabilities).toContain('/openstoa/topic/manage-members');
  expect(getRestOperation('topic_kick').capabilities).not.toContain('/openstoa/topic/leave');
 });
});
