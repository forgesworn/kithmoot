import { expect, it } from 'vitest'
import { metadataConnection } from './metadata-connection.js'
it('reports the selected route and own observed address without remote IPs or credentials', () => {
  const stats = [
    { type:'transport', selectedCandidatePairId:'pair', bytesSent:100, bytesReceived:200 },
    { type:'candidate-pair', id:'pair', localCandidateId:'own', remoteCandidateId:'other' },
    { type:'local-candidate', id:'own', candidateType:'srflx', address:'203.0.113.2', protocol:'udp', password:'secret' },
    { type:'remote-candidate', id:'other', candidateType:'relay', address:'198.51.100.10' },
    { type:'local-candidate', candidateType:'relay', address:'192.0.2.1' },
  ]
  const result = metadataConnection('connected',stats)
  expect(result).toEqual({call:{state:'connected',route:'Through a TURN relay over UDP',sent:100,received:200},addresses:['203.0.113.2']})
  expect(JSON.stringify(result)).not.toContain('secret')
})
it('leaves an unobserved route unknown instead of claiming direct media', () => {
  expect(metadataConnection('connecting',[])).toEqual({call:{state:'connecting',route:'Selected route unavailable',sent:0,received:0},addresses:[]})
})
