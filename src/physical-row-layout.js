/** Final navigation rows, after typographic/math components have been resolved.
 * A physical row is independent of text content and horizontal whitespace.
 * Its reading direction, main baseline and actual layout region define it.
 * Returns groups of source indices without modifying the input units.
 */
export function physicalRowGroups(lines, regionFor = line => line.regionId ?? 'page') {
  const records = lines.map((line,index)=>({line,index,angle:line.angle||0,
    baseline:Number.isFinite(line.baselineOffset)?line.baselineOffset:
      -Math.sin(line.angle||0)*line.baselineX+Math.cos(line.angle||0)*line.baselineY,
    em:line.fontHeight||Math.min(line.width,line.height)}));
  const regions=new Map();
  for(const record of records){
    const region=regionFor(record.line,record.baseline),id=typeof region==='object'?region.id:region;
    if(!regions.has(id))regions.set(id,[]);regions.get(id).push(record);
  }
  const groups=[];
  for(const region of regions.values()){
    const bands=[];
    for(const record of region.sort((a,b)=>a.baseline-b.baseline||a.index-b.index)){
    if(!Number.isFinite(record.baseline)||!(record.em>0)){
      bands.push({angle:record.angle,low:record.baseline,high:record.baseline,em:record.em,records:[record]});continue;
    }
    const band=bands.find(candidate=>Math.abs(Math.sin(record.angle-candidate.angle))<.03
      &&Math.cos(record.angle-candidate.angle)>.99
      &&Math.max(candidate.high,record.baseline)-Math.min(candidate.low,record.baseline)<=Math.min(candidate.em,record.em)*.25);
    if(band){band.low=Math.min(band.low,record.baseline);band.high=Math.max(band.high,record.baseline);
      band.em=Math.min(band.em,record.em);band.records.push(record);}
    else bands.push({angle:record.angle,low:record.baseline,high:record.baseline,em:record.em,records:[record]});
    }
    groups.push(...bands.map(band=>band.records.map(record=>record.index)));
  }
  return groups;
}
