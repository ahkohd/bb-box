import { SelkiesSession } from '../work/src/app/selkies.ts';
const session = new SelkiesSession(`ws://${location.host}/stream`);
document.body.style.cssText='margin:0;background:#171717;color:white;font:16px Arial';
document.body.innerHTML='<div style="height:40px;padding:8px">Box desktop - viewer without control</div>';
session.element.style.cssText='position:relative;width:1024px;height:768px';
document.body.append(session.element);
session.setControl(false,false);
session.connect();
