import { test, expect } from 'bun:test'
import { createHmac } from 'node:crypto'
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { handleFabricWebhook } from '../src/fabric'
import { recipeMenu, recipeView, type Recipe } from '../src/fabric-recipes'
import { createSlackbotV2 } from '../src/index'
import { createMemoryState } from '@chat-adapter/state-memory'

const recipe: Recipe = { id:'evidence-review',version:'1.0.0',digest:'a'.repeat(64),title:'Review prior work',description:'A checked review',aliases:['review'],taskType:'retained-evidence-review',defaultProfile:'focused',roles:['Coordinator','Worker','Checker'],profiles:{focused:{title:'Focused',description:'Three sources',maxCalls:{coordinator:4,worker:4,checker:6}},full:{title:'Full packet',description:'Seven sources',maxCalls:{coordinator:4,worker:8,checker:6}}} }
const event = (text: string, id='E1') => ({type:'event_callback',team_id:'T1',event_id:id,event:{type:'app_mention',user:'U1',channel:'C1',ts:'1789846137.000001',text:'<@UBOT> '+text}})
async function fixture(work: (send: (payload:any, signed?:boolean)=>Promise<Response|undefined>, calls:any[])=>Promise<void>, failure?:string, throughRoute=false) {
  const dir=mkdtempSync(tmpdir()+'/fabric-recipes-');writeFileSync(dir+'/token','test-identity')
  const calls:any[]=[], waits:Promise<unknown>[]=[]
  const options={apiUrl:'',botToken:'test',signingSecret:'test',fabricIntakeUrl:'http://intake',fabricTokenPath:dir+'/token',launcherAllowedTeamIds:['T1'],launcherAllowedChannelIds:['C1'],launcherAllowedUserIds:['U1'],fetch:(async(url:any,init:any)=>{
    const path=new URL(String(url)).pathname,body=init.body?JSON.parse(init.body):undefined;calls.push({path,body})
    if(path==='/v1/runs' && init.method==='GET')return Response.json({runs:[]})
    if(path==='/v1/recipes')return Response.json({recipes:[recipe]})
    if(path==='/v1/work-items')return Response.json({projects:[{name:'Research',items:[{name:'Review prior work',identifier:'RES-1',url:'https://plane.example.test/work'}]}],stale:false})
    if(path==='/v1/runs' && init.method==='POST')return failure?Response.json({error:failure},{status:failure==='TEMPORARY'?503:409}):Response.json({created:true},{status:202})
    if(path==='/api/chat.postMessage')return Response.json({ok:true,ts:'2'})
    if(path==='/api/views.open')return Response.json({ok:true})
    throw new Error('unexpected '+path)
  }) as typeof fetch}
  const bot=throughRoute?createSlackbotV2({...options,state:createMemoryState(),recoverRenderObligationsOnStart:false}):undefined
  const send=async(payload:any,signed=true)=>{
    const raw=payload.type==='event_callback'?JSON.stringify(payload):new URLSearchParams({payload:JSON.stringify(payload)}).toString(),stamp=String(Math.floor(Date.now()/1000))
    const signature='v0='+createHmac('sha256','test').update(`v0:${stamp}:${raw}`).digest('hex')
    const path=payload.type==='event_callback'?'/api/slack/events':'/api/webhooks/slack/actions'
    const req=new Request('http://localhost'+path,{method:'POST',body:raw,headers:signed?{'x-slack-signature':signature,'x-slack-request-timestamp':stamp}:{}})
    const response=bot?await bot.app.request(req):await handleFabricWebhook(req,raw,options,p=>waits.push(p));await Promise.all(waits);return response
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

test('connector attribution is handled for recent runs, menus and named recipes',async()=>fixture(async(send,calls)=>{
  await send(event('fabric runs *Sent using* <@UCHATGPT>'))
  expect(calls.filter(c=>c.path==='/v1/runs' && !c.body)).toHaveLength(1)
  expect(calls.find(c=>c.path.endsWith('chat.postMessage')).body.text).toContain('No fabric runs')
  await send(event('fabric recipes *Sent using* <@UCHATGPT>'))
  expect(calls.filter(c=>c.path.endsWith('chat.postMessage')).at(-1).body.blocks).toBeDefined()
  await send(event('fabric run review focused https://plane.example.test/work *Sent using* <@UCHATGPT>'))
  expect(calls.filter(c=>c.path==='/v1/runs' && c.body)).toHaveLength(1)
}))

test('choosing a work item submits the same typed intake and ambiguous input stays in the form',async()=>fixture(async(send,calls)=>{
  await send(opening)
  const view=calls.find(c=>c.path.endsWith('views.open')).body.view
  expect(view.blocks.find((b:any)=>b.block_id==='work').element.option_groups[0].label.text).toBe('Research')
  const selected=submission(view)
  selected.view.state.values.plane.url.value=''
  ;(selected.view.state.values as any).work={item:{selected_option:{value:'https://plane.example.test/work'}}}
  await send(selected)
  expect(calls.find(c=>c.path==='/v1/runs' && c.body).body.planeUrl).toBe('https://plane.example.test/work')
  selected.view.state.values.plane.url.value='https://plane.example.test/different'
  expect(await (await send(selected))!.json()).toMatchObject({response_action:'errors'})
  expect(calls.filter(c=>c.path==='/v1/runs' && c.body)).toHaveLength(1)
}))

test('navigation is read only and actor gates also protect buttons',async()=>fixture(async(send,calls)=>{
  const recent={...opening,actions:[{action_id:'fabric_recipe_recent'}]}
  await send(recent)
  expect(calls.find(c=>c.path.endsWith('chat.postMessage')).body.blocks).toBeDefined()
  expect((await send({...recent,user:{id:'OTHER'}}))?.status).toBe(403)
  expect(calls.filter(c=>c.path==='/v1/runs' && c.body)).toHaveLength(0)
}))

test('the configured legacy actions endpoint opens and submits recipes before launcher fallback',async()=>fixture(async(send,calls)=>{
  expect((await send(opening,false))?.status).toBe(401)
  expect((await send(opening))?.status).toBe(200)
  const view=calls.find(c=>c.path.endsWith('views.open')).body.view
  expect((await send(submission(view)))?.status).toBe(200)
  expect(calls.filter(c=>c.path==='/v1/runs' && c.body)).toHaveLength(1)
  expect((await send({...opening,actions:[{action_id:'unsupported_legacy_action',value:'bad'}]}))?.status).toBe(400)
},undefined,true))
