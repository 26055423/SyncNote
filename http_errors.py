class Error(Exception):
 def __init__(self,text,code=400):self.text,self.code=text,code
