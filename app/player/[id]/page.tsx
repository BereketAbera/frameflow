import { PlayerView } from "./player-view";
export default async function PlayerPage({params}:{params:Promise<{id:string}>}){const{id}=await params;return <PlayerView id={id}/>}
