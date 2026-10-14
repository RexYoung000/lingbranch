import {X} from 'lucide-react';
import type {Idea} from '@/lib/idea-store';
import {previewPosition} from '../../shared/relationship-layout.mjs';
import InspirationCard from './inspiration-card';

export default function RelationshipPreview({idea,point,transform,viewport,onOpen,onClose}:{
  idea:Idea;point:{x:number;y:number};transform:{panX:number;panY:number;zoom:number};viewport:{width:number;height:number};onOpen:()=>void;onClose:()=>void;
}) {
  const position=previewPosition(point,transform,viewport);
  return <aside className="atlas-preview" aria-label="灵感卡片预览" style={{left:position.left,top:position.top,width:position.width}}>
    <button className="atlas-preview-close" onClick={onClose} aria-label="收起卡片"><X size={16}/></button>
    <InspirationCard idea={idea} onOpen={onOpen} className="atlas-preview-card" style={{width:position.width,height:position.height}} autoFocus showOpenHint/>
  </aside>;
}
