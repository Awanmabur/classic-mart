const code39Patterns=Object.freeze({
 '0':'nnnwwnwnn','1':'wnnwnnnnw','2':'nnwwnnnnw','3':'wnwwnnnnn','4':'nnnwwnnnw','5':'wnnwwnnnn','6':'nnwwwnnnn','7':'nnnwnnwnw','8':'wnnwnnwnn','9':'nnwwnnwnn',
 A:'wnnnnwnnw',B:'nnwnnwnnw',C:'wnwnnwnnn',D:'nnnnwwnnw',E:'wnnnwwnnn',F:'nnwnwwnnn',G:'nnnnnwwnw',H:'wnnnnwwnn',I:'nnwnnwwnn',J:'nnnnwwwnn',
 K:'wnnnnnnww',L:'nnwnnnnww',M:'wnwnnnnwn',N:'nnnnwnnww',O:'wnnnwnnwn',P:'nnwnwnnwn',Q:'nnnnnnwww',R:'wnnnnnwwn',S:'nnwnnnwwn',T:'nnnnwnwwn',
 U:'wwnnnnnnw',V:'nwwnnnnnw',W:'wwwnnnnnn',X:'nwnnwnnnw',Y:'wwnnwnnnn',Z:'nwwnwnnnn','-':'nwnnnnwnw','.':'wwnnnnwnn',' ':'nwwnnnwnn','$':'nwnwnwnnn','/':'nwnwnnnwn','+':'nwnnnwnwn','%':'nnnwnwnwn','*':'nwnnwnwnn',
});
export function code39Geometry(value){const clean=String(value||'').toUpperCase();if(!clean||[...clean].some(ch=>!code39Patterns[ch]))return {value:clean,width:1,height:66,rects:[]};const encoded=`*${clean}*`;const narrow=2,wide=5,gap=2,height=58,margin=10;let x=margin;const rects=[];for(const ch of encoded){const pattern=code39Patterns[ch];for(let i=0;i<pattern.length;i+=1){const barWidth=pattern[i]==='w'?wide:narrow;if(i%2===0)rects.push({x,width:barWidth});x+=barWidth;}x+=gap;}return {value:clean,width:x+margin-gap,height:height+8,barHeight:height,rects};}
