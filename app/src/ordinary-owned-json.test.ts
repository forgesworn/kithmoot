import {describe,it,expect,vi} from 'vitest'
import {ordinaryOwnedJSON} from './ordinary-owned-json.js'
import {OrdinaryStateHold} from './ordinary-state-codec.js'

describe('owned JSON ignores inherited serialisation hooks (data only)',()=>{
  it('preserves canonical owned JSON including field order and escaped strings',()=>{
    for(const input of [null,true,0,-0,42,'"\n\\',[1,'two',null],{id:'a',source:[1,2],authority:{endsAt:null}},Object.assign(Object.create(null),{a:1})])expect(ordinaryOwnedJSON(input)).toBe(JSON.stringify(input))
  })
  it('cannot collapse unequal objects or arrays through inherited toJSON',()=>{
    const inherited=vi.fn(()=>'same')
    Object.defineProperty(Object.prototype,'toJSON',{configurable:true,value:inherited})
    try{
      const a=ordinaryOwnedJSON({header:{id:'a'},scopes:[['browser',1]],authority:{endsAt:10}})
      const b=ordinaryOwnedJSON({header:{id:'b'},scopes:[['browser',2]],authority:{endsAt:20}})
      expect(a===b).toBe(false);expect(inherited.mock.calls.length).toBe(0)
    }finally{Reflect.deleteProperty(Object.prototype,'toJSON')}
  })
  it('rejects accessors, holes, hidden properties, symbols and custom prototypes without invoking getters',()=>{
    const getter=vi.fn(),accessor=Object.defineProperty({},'x',{enumerable:true,get:getter})
    for(const input of [accessor,[,1],Object.defineProperty({},'x',{value:1}),{[Symbol('x')]:1},Object.create({x:1}),{toJSON:getter},undefined,NaN,Infinity])expect(()=>ordinaryOwnedJSON(input)).toThrow(OrdinaryStateHold)
    expect(getter).not.toHaveBeenCalled()
  })
  it('bounds recursion, nodes and aggregate string units',()=>{
    const cycle:any={};cycle.next=cycle
    for(const input of [cycle,'a'.repeat(1_048_577),Array(16_385).fill(null)])expect(()=>ordinaryOwnedJSON(input)).toThrow(OrdinaryStateHold)
  })
})
