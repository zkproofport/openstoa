import {expect,it,vi} from 'vitest';
vi.mock('@/lib/db',()=>({db:{}}));
import {ALLOWED_CMDS} from '@/lib/aiPermissions';
import {cmdLabel} from '@/lib/apiKeyForm';
import {translate} from '@/lib/i18n';
it.each(['en','ko'] as const)('every grantable API capability has an understandable settings label (%s)',locale=>{
 for(const cmd of ALLOWED_CMDS){
  const label=cmdLabel(cmd,(key,params)=>translate(locale,key,params));
  expect(label,cmd).not.toBe(cmd);
  expect(label,cmd).not.toMatch(/^webUi\./);
  expect(label.trim(),cmd).not.toBe('');
 }
});
