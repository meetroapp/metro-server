"use strict";
const locationService=require('./punchLocationService');
const {send}=require('./jobAssignments');
function createPunchLocationHandlers({getPool,sendPublicDatabaseError,service=locationService}){
  const handle=(method,fields,query=false)=>async(req,res)=>{
    res.setHeader?.('Cache-Control','private, no-store');
    try{
      const body=query?req.query||{}:req.body||{};
      if(Object.keys(body).some(k=>!fields.includes(k)))return send(res,{ok:false,status:400,code:'PUNCH_INPUT_UNRECOGNIZED',message:'Only the governed location inputs are accepted.'});
      const input={pool:getPool(req),authenticatedActor:req.user};
      for(const k of fields)input[k]=body[k];
      if(req.params?.assignmentId)input.assignmentId=req.params.assignmentId;
      return send(res,await service[method](input));
    }catch(error){return sendPublicDatabaseError({res,error,operation:method,code:'PUNCH_LOCATION_OPERATION_FAILED',message:'The location operation could not be completed.'});}
  };
  return {
    policy:handle('writePolicy',['businessId','id','expectedVersion','state','policy','idempotencyKey']),
    site:handle('writeSite',['businessId','id','expectedVersion','state','kind','label','jobId','address','latitude','longitude','policyId','policyVersion','idempotencyKey']),
    association:handle('authorizeAssignmentSite',['businessId','siteId','siteVersion','assignmentActivationVersion','expectedVersion','state','idempotencyKey']),
    managed:handle('listSites',['businessId'],true),
    assigned:handle('listSites',['businessId'],true),
    snapshot:handle('recordSnapshot',['businessId','siteId','siteVersion','associationVersion','assignmentActivationVersion','boundary','snapshot','idempotencyKey']),
    own:handle('listOwnSnapshots',['businessId'],true),
  };
}
function registerPunchLocationRoutes(options){
  const {app,authMiddleware}=options;
  if(!app||typeof authMiddleware!=='function')throw new TypeError('Punch location route dependencies are required.');
  const h=createPunchLocationHandlers(options);
  app.put('/team/punch-location-policies',authMiddleware,h.policy);
  app.put('/team/punch-sites',authMiddleware,h.site);
  app.get('/team/punch-sites',authMiddleware,h.managed);
  app.put('/team/assignments/:assignmentId/punch-sites',authMiddleware,h.association);
  app.get('/employee/assignments/:assignmentId/punch-sites',authMiddleware,h.assigned);
  app.post('/employee/assignments/:assignmentId/punch-location-snapshots',authMiddleware,h.snapshot);
  app.get('/employee/punch-location-snapshots',authMiddleware,h.own);
  return h;
}
module.exports={createPunchLocationHandlers,registerPunchLocationRoutes};
