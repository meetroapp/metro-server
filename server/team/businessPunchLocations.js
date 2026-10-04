"use strict";
const service=require('./businessPunchLocationService');
const {send}=require('./jobAssignments');
function createBusinessPunchLocationHandlers({getPool,sendPublicDatabaseError,managementService=service}) {
  const handle=(method,fields,query=false)=>async(req,res)=>{
    res.setHeader?.('Cache-Control','private, no-store');
    try {
      const body=query?req.query||{}:req.body||{};
      if(!body||typeof body!=='object'||Array.isArray(body)||Object.keys(body).some(key=>!fields.includes(key)))return send(res,{ok:false,status:400,code:'PUNCH_INPUT_UNRECOGNIZED',message:'Only governed location-management inputs are accepted.'});
      const input={pool:getPool(req),authenticatedActor:req.user,assignmentId:req.params?.assignmentId};
      for(const key of fields)input[key]=body[key];
      return send(res,await managementService[method](input));
    }catch(error){return sendPublicDatabaseError({res,error,operation:method,code:'PUNCH_LOCATION_MANAGEMENT_FAILED',message:'Location management could not be completed.'});}
  };
  const identity=['businessId','employeeMembershipId'];
  const mutation=[...identity,'expectedAssignmentVersion','assignmentActivationVersion','expectedVersion','idempotencyKey'];
  return {read:handle('readManagement',identity,true),save:handle('saveAssignmentSite',[...mutation,'site']),authorization:handle('changeAuthorization',[...mutation,'siteId','siteVersion','state'])};
}
function registerBusinessPunchLocationRoutes(options) {
  const h=createBusinessPunchLocationHandlers(options),{app,authMiddleware}=options;
  app.get('/team/assignments/:assignmentId/punch-location-management',authMiddleware,h.read);
  app.put('/team/assignments/:assignmentId/punch-location-management',authMiddleware,h.save);
  app.put('/team/assignments/:assignmentId/punch-location-authorizations',authMiddleware,h.authorization);
  return h;
}
module.exports={createBusinessPunchLocationHandlers,registerBusinessPunchLocationRoutes};
