import{WatchView}from"./watch-view";export default async function Page({params}:{params:Promise<{id:string}>}){return <WatchView id={(await params).id}/>}
