// Compile-only integration fixture; never attach or execute for regression tests.
#property strict
#include "../../bridge/SyncNoteLocalSocket.mqh"
#include "../../bridge/SyncTradeRisk.mqh"
void LocalMessage(const int index,const string message) {}
void LocalOpened(const int index) {}
void LocalClosed(const int index) {}
void OnStart() { /* Deliberately does not open files, connect, or submit trades. */ }
