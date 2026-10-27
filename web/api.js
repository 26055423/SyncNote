// Read requests may retry across a short proxy interruption. Writes never retry.
window.tongpinAPI=async function(path,data){
 const writing=data!==undefined;
 for(let attempt=0;attempt<(writing?1:3);attempt++){
  let response;
  try{response=await fetch(path,{cache:'no-store',headers:{Accept:'application/json',...(writing?{'Content-Type':'application/json'}:{})},...(writing?{method:'POST',body:JSON.stringify(data)}:{})});}
  catch(e){if(!writing&&attempt<2){await new Promise(r=>setTimeout(r,600*(attempt+1)));continue;}throw Error('网络连接中断，请稍后重试');}
  if(response.status===401){location.replace('/login');throw Error('登录已过期，请重新登录');}
  const isJSON=(response.headers.get('Content-Type')||'').includes('application/json');
  if(!isJSON){
   if(!writing&&attempt<2&&[200,502,503,504].includes(response.status)){await new Promise(r=>setTimeout(r,600*(attempt+1)));continue;}
   throw Error(response.status===403?'请求被公网访问保护拦截，请刷新页面后重试':'网站连接暂时异常（HTTP '+response.status+'），请稍后重试');
  }
  let value;try{value=await response.json();}catch{throw Error('网站返回的数据不完整，请稍后重试');}
  if(!response.ok){if(!writing&&attempt<2&&[502,503,504].includes(response.status)){await new Promise(r=>setTimeout(r,600*(attempt+1)));continue;}throw Error(value.error||'请求失败（HTTP '+response.status+'）');}
  return value;
 }
};
