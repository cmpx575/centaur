import { test, expect } from 'bun:test'
import { createHmac } from 'node:crypto'
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { handleFabricWebhook } from '../src/fabric'
import { recipeMenu, recipeView, type Recipe } from '../src/fabric-recipes'

const recipe: Recipe = { id:'evidence-review',version:'1.0.0',digest:'a'.repeat(64),title:'Review prior work',description:'A checked review',aliases:['review'],taskType:'retained-evidence-review',defaultProfile:'focused',roles:['Coordinator','Worker','Checker'],profiles:{focused:{title:'Focused',description:'Three sources',maxCalls:{coordinator:4,worker:4,checker:6}},full:{title:'Full packet',description:'Seven sources',maxCalls:{coordinator:4,worker:8,checker:6}}} }
const event = (text: string, id='E1') => ({type:'event_callback',team_id:'T1',event_id:id,event:{type:'app_mention',user:'U1',channel:'C1',ts:'1789846137.000001',text:'<@UBOT> '+text}})
async function fixture(work: (send: (payload:any, signed?:boolean)=>Promise<Response|undefined>, calls:any[])=>Promise<void>, failure?:string) {
  const dir=mkdtempSync(tmpdir()+'/fabric-recipes-');writeFileSync(dir+'/token','test-identity')
  const calls:any[]=[], waits:Promise<unknown>[]=[]
  const options={apiUrl:'',botToken:'test',signingSecret:'test',fabricIntakeUrl:'http://intake',fabricTokenPath:dir+'/token',launcherAllowedTeamIds:['T1'],launcherAllowedChannelIds:['C1'],launcherAllowedUserIds:['U1'],fetch:(async(url:any,init:any)=>{
    const path=new URL(String(url)).pathname,body=init.body?JSON.parse(init.body):undefined;calls.push({path,body})
    if(path==='/v1/recipes')return Response.json({recipes:[recipe]})
    if(path==='/v1/runs' && init.method==='POST')return failure?Response.json({error:failure},{status:failure==='TEMPORARY'?503:409}):Response.json({created:true},{status:202})
    if(path==='/api/chat.postMessage')return Response.json({ok:true,ts:'2'})
    if(path==='/api/views.open')return Response.json({ok:true})
    throw new Error('unexpected '+path)
  }) as typeof fetch}
  const send=async(payload:any,signed=true)=>{
    const raw=payload.type==='event_callback'?JSON.stringify(payload):new URLSearchParams({payload:JSON.stringify(payload)}).toString(),stamp=String(Math.floor(Date.now()/1000))
    const signature='v0='+createHmac('sha256','test').update(`v0:${stamp}:${raw}`).digest('hex')
    const req=new Request('http://localhost/slack/events',{headers:signed?{'x-slack-signature':signature,'x-slack-request-timestamp':stamp}:{}})
    const response=await handleFabricWebhook(req,raw,options,p=>waits.push(p));await Promise.all(waits);return response
  }
  try{await work(send,calls)}finally{rmSync(dir,{recursive:true,force:true})}
}
const opening={type:'block_actions',team:{id:'T1'},user:{id:'U1'},channel:{id:'C1'},message:{ts:'1789846137.000001'},trigger_id:'trigger',actions:[{action_id:'fabric_recipe_open',value:'evidence-review'}]}
const submission=(view:any)=>({type:'view_submission',team:{id:'T1'},user:{id:'U1'},view:{...view,id:'V1',state:{values:{plane:{url:{value:'https://plane.example.test/work'}},profile:{choice:{selected_option:{value:'full'}}}}}}})

test('signed menu and modal preserve origin and pin a compact immutable recipe',async()=>fixture(async(send,calls)=>{
  expect((await send(event('fabric recipes')))?.status).toBe(200)
  expect(calls.find(c=>c.path.endsWith('chat.postMessage')).body.blocks).toEqual(recipeMenu([recipe]).blocks)
  await send(opening)
  const view=calls.find(c=>c.path.endsWith('views.open')).body.view
  expect(view.private_metadata.length).toBeLessThan(3000)
  expect((await send(submission(view)))?.status).toBe(200)
  const requests=calls.filter(c=>c.path==='/v1/runs')
  expect(requests[0].body).toMatchObject({recipeId:recipe.id,recipeDigest:recipe.digest,profile:'full',channelId:'C1',threadTs:'1789846137.000001',userId:'U1'})
  await send(submission(view))
  expect(calls.filter(c=>c.path==='/v1/runs')[1].body).toEqual(requests[0].body)
}))
test('unsigned, wrong user and tampered modal never submit',async()=>fixture(async(send,calls)=>{
  expect((await send(opening,false))?.status).toBe(401)
  await send(opening);const view=calls.find(c=>c.path.endsWith('views.open')).body.view
  expect((await send({...submission(view),user:{id:'U2'}}))?.status).toBe(403)
  expect((await send(submission({...view,private_metadata:view.private_metadata.replace('evidence-review','arbitrary')})))?.status).toBe(403)
  expect(calls.filter(c=>c.path==='/v1/runs')).toHaveLength(0)
}))
test('named alias and profile use same canonical request and stable replay key',async()=>fixture(async(send,calls)=>{
  await send(event('fabric run REVIEW FULL <https://plane.example.test/work|work>\nignored footer'))
  await send(event('fabric run REVIEW FULL <https://plane.example.test/work|work>\nignored footer'))
  const requests=calls.filter(c=>c.path==='/v1/runs');expect(requests).toHaveLength(2)
  expect(requests[0].body).toEqual(requests[1].body)
  expect(requests[0].body).toMatchObject({recipeId:'evidence-review',profile:'full',planeUrl:'https://plane.example.test/work'})
}))
test('a stale recipe remains a visible modal error and no silent default is used',async()=>fixture(async(send,calls)=>{
  await send(opening);const view=calls.find(c=>c.path.endsWith('views.open')).body.view
  const r=await send(submission(view));expect(await r!.json()).toMatchObject({response_action:'errors',errors:{profile:expect.stringContaining('RECIPE_CHANGED')}})
},'RECIPE_CHANGED_REFRESH_MENU'))
test('transient intake failure preserves Slack retry',async()=>fixture(async(send)=>{
  expect((await send(event('fabric run review https://plane.example.test/work')))?.status).toBe(503)
},'TEMPORARY'))
test('all recipe choice descriptions meet Slack option limits',()=>{
  const view=recipeView({...recipe,profiles:{focused:{...recipe.profiles.focused!,description:'x'.repeat(200)}}},'test')
  const select:any=view.blocks.find((b:any)=>b.block_id==='profile');expect(select.element.options[0].description.text.length).toBe(75)
})
