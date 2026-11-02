int main(int argc,char** argv){
 if(argc!=2)return 2;string scenario=argv[1];
 // Each process is a fresh synthetic account/EA runtime.
 InpAllowTrading=true;
 if(scenario=="trading_off")InpAllowTrading=false;
 if(scenario.rfind("real",0)==0){fake_mode=ACCOUNT_TRADE_MODE_REAL;InpAllowRealTrading=true;}
 if(scenario=="real_off")InpAllowRealTrading=false;
 if(scenario=="real_zero_cap")InpRealMaxLots=0;
 if(scenario=="contest")fake_mode=ACCOUNT_TRADE_MODE_CONTEST;
 if(scenario=="permissions_off")fake_permissions=false;
 if(scenario=="expired")fake_utc+=20000;
 if(scenario=="journal_failed")fake_journal_failure=true;
 if(scenario=="expires_during_flush")fake_flush_delay=20000;
 if(scenario=="account_changes_during_flush"||scenario=="real_account_changes_during_flush")fake_switch_account=true;
 if(scenario=="netting_manual"||scenario=="netting_owned"){
  fake_margin=ACCOUNT_MARGIN_MODE_RETAIL_NETTING;fake_positions.push_back({7001,scenario=="netting_manual"?0:InpMagic,.03,POSITION_TYPE_BUY});
 }
 if(scenario=="real_risk_unhealthy")fake_risk_healthy=false;
 if(scenario=="real_loss_unavailable"){fake_loss_allowed=false;InpMaxDailyLoss=100;}
 if(scenario=="real_reserve_failed")fake_reserve_ok=false;
 if(scenario=="real_unknown_result")fake_retcode=10012;
 if(scenario=="real_broker_rejected")fake_retcode=10006;
 if(scenario=="real_broker_placed")fake_retcode=10008;
 if(scenario=="real_netting_changes_during_flush"){fake_margin=ACCOUNT_MARGIN_MODE_RETAIL_NETTING;fake_manual_appears=true;}
 if(scenario=="real_midnight_during_flush"){fake_utc=1700006399500LL;fake_flush_delay=1000;}
 if(scenario=="position_symbol_unavailable")fake_positions.push_back({7001,0,1,POSITION_TYPE_BUY,""});
 if(scenario=="order_symbol_unavailable")fake_orders.push_back({8001,0,1,""});
 if(scenario=="pending_exposure_limit")fake_orders.push_back({8001,0,1});
 if(scenario=="netting_existing_order"){fake_margin=ACCOUNT_MARGIN_MODE_RETAIL_NETTING;fake_orders.push_back({8001,0,.01});}
 string request;std::getline(std::cin,request);
 if(!JsonValidateFlat(request))throw std::runtime_error("Synthetic request is not flat JSON");
 HandleTradeCommand(0,request);
 if(scenario=="real_duplicate")HandleTradeCommand(0,request);
 string events="[";for(std::size_t i=0;i<fake_events.size();i++){if(i)events+=",";events+=JStr(fake_events[i]);}events+="]";
 if(fake_reply.empty())throw std::runtime_error("Command handler did not reply");
 std::cout<<"{\"sends\":"<<fake_sends<<",\"reserved\":"<<fake_reserved<<",\"events\":"<<events<<",\"result\":"<<fake_reply<<",\"request\":{\"action\":"<<fake_request.action<<",\"type\":"<<fake_request.type<<",\"type_filling\":"<<fake_request.type_filling<<",\"volume\":"<<fake_request.volume<<",\"price\":"<<fake_request.price<<",\"sl\":"<<fake_request.sl<<",\"tp\":"<<fake_request.tp<<"}}";
}
